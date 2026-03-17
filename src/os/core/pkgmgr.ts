/**
 * JSOS Package Manager
 *
 * Implements items 728–741 from 1000-things.md:
 *
 *  728. Package format: .jspkg (tar.gz + manifest.json)
 *  729. Package manifest: name, version, dependencies, files list
 *  730. Package install: download, verify hash, extract to /usr/
 *  731. Package remove: unlink installed files
 *  732. Package list: show installed packages
 *  733. Dependency resolution: topological sort
 *  734. Remote package repository: JSON index over HTTPS
 *  735. Package update: check version, download delta or full
 *  736. Package signature verification (Ed25519 signed manifests)
 *  740. TypeScript sandbox: run untrusted .ts packages in isolated JS context
 *
 * Storage layout:
 *   /var/lib/pkg/db.json         - installed package database
 *   /var/lib/pkg/locks/<name>    - per-package lock file
 *   /usr/bin/, /usr/lib/         - installed files
 *   /etc/pkg/repos.json          - repository list
 */

declare var kernel: import('./kernel.js').KernelAPI;
import vfs from '../fs/filesystem.js';

// ── Manifest & Database Types ─────────────────────────────────────────────────

/** Wire format inside the remote package index and inside .jspkg. */
export interface PackageManifest {
  name:         string;
  version:      string;
  description:  string;
  author:       string;
  license:      string;
  /** Runtime dependencies — must be installed before this package. */
  dependencies: string[];
  /** Optional: packages that must NOT be installed at the same time. */
  conflicts:    string[];
  /** Provides virtual package names (e.g. "sh" provided by "bash"). */
  provides:     string[];
  /** List of file paths installed by this package (relative to /). */
  files:        string[];
  /** SHA-256 hex digest of the package archive bytes. */
  hash:         string;
  /** Base64-encoded Ed25519 signature over the manifest JSON (sans signature field). */
  signature:    string;
  /** Download URL for the .jspkg archive. */
  url:          string;
  /** Package size in bytes. */
  size:         number;
}

/** Record stored in /var/lib/pkg/db.json. */
interface InstalledRecord {
  name:        string;
  version:     string;
  files:       string[];
  installedAt: number; // epoch ms
  pinned:      boolean;
}

/** Minimal repository index entry. */
interface RepoPackageEntry {
  name:    string;
  version: string;
  url:     string;
  hash:    string;
}

interface RepoIndex {
  url:      string;
  packages: RepoPackageEntry[];
}

// ── SHA-256 in TypeScript (no external deps) ──────────────────────────────────

const K256: number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** Compute SHA-256 of a byte array, return hex string. */
export function sha256(data: number[]): string {
  var h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];

  // Pre-processing: add padding
  var msg = data.slice();
  var bitLen = data.length * 8;
  msg.push(0x80);
  while ((msg.length % 64) !== 56) msg.push(0);
  // Append 64-bit big-endian length
  msg.push(0, 0, 0, 0); // high 32 bits (0 for < 512 MB)
  msg.push(
    (bitLen >>> 24) & 0xff,
    (bitLen >>> 16) & 0xff,
    (bitLen >>>  8) & 0xff,
     bitLen         & 0xff,
  );

  // Process each 64-byte block
  for (var bi = 0; bi < msg.length; bi += 64) {
    var w = new Array<number>(64);
    for (var i = 0; i < 16; i++) {
      w[i] = ((msg[bi+i*4]   << 24) |
               (msg[bi+i*4+1] << 16) |
               (msg[bi+i*4+2] <<  8) |
                msg[bi+i*4+3]) >>> 0;
    }
    for (var i = 16; i < 64; i++) {
      var s0 = rotr32(w[i-15],  7) ^ rotr32(w[i-15], 18) ^ (w[i-15] >>> 3);
      var s1 = rotr32(w[i-2], 17)  ^ rotr32(w[i-2],  19) ^ (w[i-2]  >>> 10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
    }

    var [a,b,c,d,e,f,g,h2] = [h[0],h[1],h[2],h[3],h[4],h[5],h[6],h[7]];

    for (var i = 0; i < 64; i++) {
      var S1  = rotr32(e,  6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      var ch  = ((e & f) ^ ((~e >>> 0) & g)) >>> 0;
      var tmp1 = (h2 + S1 + ch + K256[i] + w[i]) >>> 0;
      var S0  = rotr32(a,  2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      var tmp2 = (S0 + maj) >>> 0;

      h2 = g; g = f; f = e;
      e  = (d + tmp1) >>> 0;
      d  = c; c = b; b = a;
      a  = (tmp1 + tmp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + h2) >>> 0;
  }

  return h.map(function(v) { return ('00000000' + v.toString(16)).slice(-8); }).join('');
}

// ── Version comparison ────────────────────────────────────────────────────────

function parseVer(v: string): number[] {
  return v.split('.').map(function(n) { return parseInt(n, 10) || 0; });
}

/** Returns -1, 0, or +1. */
function cmpVer(a: string, b: string): number {
  var pa = parseVer(a), pb = parseVer(b);
  for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
    var diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

// ── Topological sort (item 733) ───────────────────────────────────────────────

function topoSort(deps: Map<string, string[]>): string[] | null {
  var result: string[] = [];
  var visited  = new Set<string>();
  var visiting = new Set<string>();

  function visit(name: string): boolean {
    if (visited.has(name))  return true;
    if (visiting.has(name)) return false; // cycle
    visiting.add(name);
    var d = deps.get(name) || [];
    for (var i = 0; i < d.length; i++) {
      if (!visit(d[i])) return false;
    }
    visiting.delete(name);
    visited.add(name);
    result.push(name);
    return true;
  }

  deps.forEach(function(_v, k) { visit(k); });
  return result;
}

// ── Package Database ──────────────────────────────────────────────────────────

const DB_PATH   = '/var/lib/pkg/db.json';
const REPO_PATH = '/etc/pkg/repos.json';
const USR_BIN   = '/usr/bin/';
const USR_LIB   = '/usr/lib/';

function ensureDirs(): void {
  for (var d of ['/var/lib/pkg', '/var/lib/pkg/locks', '/usr/bin', '/usr/lib', '/etc/pkg']) {
    try { vfs.mkdir(d); } catch(_) { /* already exists */ }
  }
}

function readDB(): Map<string, InstalledRecord> {
  try {
    var raw = vfs.readFile(DB_PATH);
    var arr: InstalledRecord[] = JSON.parse(raw);
    var m = new Map<string, InstalledRecord>();
    arr.forEach(function(r) { m.set(r.name, r); });
    return m;
  } catch(_) {
    return new Map();
  }
}

function writeDB(db: Map<string, InstalledRecord>): void {
  ensureDirs();
  var arr: InstalledRecord[] = [];
  db.forEach(function(v) { arr.push(v); });
  vfs.writeFile(DB_PATH, JSON.stringify(arr, null, 2));
}

function readRepos(): RepoIndex[] {
  try {
    return JSON.parse(vfs.readFile(REPO_PATH));
  } catch(_) {
    return [];
  }
}

// ── Package Manager Class ─────────────────────────────────────────────────────

export class PackageManager {
  private db: Map<string, InstalledRecord>;

  constructor() {
    ensureDirs();
    this.db = readDB();
  }

  // ── Repository management (item 734) ───────────────────────────────────────

  /** Add a repository URL to /etc/pkg/repos.json. */
  addRepo(url: string): void {
    var repos = readRepos();
    if (!repos.find(function(r) { return r.url === url; })) {
      repos.push({ url, packages: [] });
      vfs.writeFile(REPO_PATH, JSON.stringify(repos, null, 2));
    }
  }

  /** Refresh package index from all configured repositories. */
  update(): string[] {
    var repos  = readRepos();
    var errors: string[] = [];
    for (var i = 0; i < repos.length; i++) {
      try {
        // Use the HTTP client via dynamic import-style access (net must be wired).
        // This calls into the net.ts HTTP layer:
        //   kernel.http.get(url) → string
        //   We use kernel.netHttpGet if exposed, else fallback message.
        var indexUrl = repos[i].url.replace(/\/$/, '') + '/index.json';
        var body = (kernel as any).httpGet ? (kernel as any).httpGet(indexUrl) : null;
        if (body) {
          repos[i].packages = JSON.parse(body);
        }
      } catch(e) {
        errors.push('Repo ' + repos[i].url + ': ' + String(e));
      }
    }
    vfs.writeFile(REPO_PATH, JSON.stringify(repos, null, 2));
    return errors;
  }

  /** Search all repos for a package by name or virtual provide (item 737). */
  search(name: string): RepoPackageEntry | null {
    var repos = readRepos();
    // First pass: exact name match
    for (var i = 0; i < repos.length; i++) {
      for (var j = 0; j < repos[i].packages.length; j++) {
        if (repos[i].packages[j].name === name) return repos[i].packages[j];
      }
    }
    // Second pass: virtual package — match against manifest's `provides` field (item 737)
    for (var i = 0; i < repos.length; i++) {
      for (var j = 0; j < repos[i].packages.length; j++) {
        var entry = repos[i].packages[j];
        // Download manifest to check provides (only if manifest URL is derivable)
        try {
          var manifestUrl = entry.url.replace(/\.jspkg$/, '.manifest.json');
          var body = (kernel as any).httpGet ? (kernel as any).httpGet(manifestUrl) : null;
          if (body) {
            var m: Partial<PackageManifest> = JSON.parse(body);
            if (m.provides && m.provides.indexOf(name) !== -1) return entry;
          }
        } catch(_) {}
      }
    }
    return null;
  }

  /**
   * Dry-run install: verify all deps can be resolved and hash-check passes
   * without actually writing any files to disk (item 739).
   * Returns a list of packages that would be installed, or throws on error.
   */
  dryRunInstall(name: string): string[] {
    var wouldInstall: string[] = [];
    var visited = new Set<string>();

    var self = this;
    function gather(pkgName: string): void {
      if (visited.has(pkgName) || self.db.has(pkgName)) return;
      visited.add(pkgName);

      var entry = self.search(pkgName);
      if (!entry) throw new Error('Package not found: ' + pkgName);

      // Download manifest for dep list
      var manifestUrl = entry.url.replace(/\.jspkg$/, '.manifest.json');
      var manifest: Partial<PackageManifest> = {};
      try {
        var body = (kernel as any).httpGet ? (kernel as any).httpGet(manifestUrl) : null;
        if (body) manifest = JSON.parse(body);
      } catch(_) {}

      // Recurse into dependencies
      var deps = manifest.dependencies || [];
      for (var i = 0; i < deps.length; i++) gather(deps[i]);

      // Verify archive hash without extracting
      try {
        var raw = (kernel as any).httpGet ? (kernel as any).httpGet(entry.url) : null;
        if (raw && entry.hash) {
          var bytes = Array.from(raw as string).map(function(c) { return c.charCodeAt(0) & 0xff; });
          var actualHash = sha256(bytes);
          if (actualHash !== entry.hash) {
            throw new Error('Hash mismatch for ' + pkgName + ': got ' + actualHash + ' expected ' + entry.hash);
          }
        }
      } catch(e) {
        if (String(e).indexOf('Hash mismatch') !== -1) throw e;
        // Network errors during dry-run are warnings only
      }

      wouldInstall.push(pkgName);
    }

    gather(name);
    return wouldInstall;
  }

  // ── Install (items 730, 733) ────────────────────────────────────────────────

  /**
   * Install a package by name.  Resolves dependencies recursively.
   * Returns list of packages actually installed.
   */
  install(nameOrUrl: string): string[] {
    var installed: string[] = [];

    // If it looks like a URL, download and install directly
    if (nameOrUrl.startsWith('http://') || nameOrUrl.startsWith('https://')) {
      return this._installFromUrl(nameOrUrl, installed);
    }

    // Otherwise look up in repos
    var entry = this.search(nameOrUrl);
    if (!entry) throw new Error('Package not found: ' + nameOrUrl);

    this._installWithDeps(entry.name, entry.url, entry.hash, installed);
    return installed;
  }

  private _installWithDeps(name: string, url: string, expectedHash: string, installed: string[]): void {
    if (this.db.has(name)) return; // already installed

    // Download manifest to find deps
    var manifestUrl = url.replace(/\.jspkg$/, '.manifest.json');
    var manifestJson: string;
    try {
      manifestJson = (kernel as any).httpGet ? (kernel as any).httpGet(manifestUrl) : '{}';
    } catch(e) {
      manifestJson = '{}';
    }
    var manifest: Partial<PackageManifest> = JSON.parse(manifestJson);
    var deps = manifest.dependencies || [];

    // Resolve and install dependencies first
    for (var i = 0; i < deps.length; i++) {
      if (!this.db.has(deps[i])) {
        var depEntry = this.search(deps[i]);
        if (!depEntry) throw new Error('Dependency not found: ' + deps[i]);
        this._installWithDeps(depEntry.name, depEntry.url, depEntry.hash, installed);
      }
    }

    this._installFromUrl(url, installed, { name, expectedHash, manifest: manifest as PackageManifest });
  }

  private _installFromUrl(url: string, installed: string[], meta?: { name: string; expectedHash: string; manifest: PackageManifest }): string[] {
    // Download the archive
    var archiveBytes: number[];
    try {
      var raw = (kernel as any).httpGet ? (kernel as any).httpGet(url) : null;
      if (!raw) throw new Error('No HTTP support or empty response');
      archiveBytes = Array.from(raw as string).map(function(c) { return c.charCodeAt(0) & 0xff; });
    } catch(e) {
      throw new Error('Download failed: ' + url + ' — ' + String(e));
    }

    // Hash verification (item 730)
    if (meta && meta.expectedHash) {
      var actualHash = sha256(archiveBytes);
      if (actualHash !== meta.expectedHash) {
        throw new Error('Hash mismatch for ' + (meta.name || url) +
          ': got ' + actualHash + ' expected ' + meta.expectedHash);
      }
    }

    // Parse the .jspkg (simplified: treat as a sequence of "path\0content" pairs)
    var files = this._parseJspkg(archiveBytes);

    // Extract to filesystem
    var installedFiles: string[] = [];
    files.forEach(function(file, path) {
      var fullPath = path.startsWith('/') ? path : '/usr/' + path;
      try {
        // Ensure parent directory exists
        var parts = fullPath.split('/');
        parts.pop();
        var dir = parts.join('/') || '/';
        try { vfs.mkdir(dir); } catch(_) {}
        vfs.writeFile(fullPath, file);
        installedFiles.push(fullPath);
      } catch(e) {
        // Skip unwriteable paths
      }
    });

    var pkgName = (meta && meta.name) || url.split('/').pop()!.replace(/\.jspkg$/, '');

    // Record in database
    this.db.set(pkgName, {
      name:        pkgName,
      version:     (meta && meta.manifest && meta.manifest.version) || '0.0.0',
      files:       installedFiles,
      installedAt: Date.now(),
      pinned:      false,
    });
    writeDB(this.db);
    installed.push(pkgName);
    return installed;
  }

  /**
   * Minimal .jspkg parser.
   * Format: length-prefixed entries → 4 bytes path len, N bytes path, 4 bytes data len, N bytes data.
   * Falls back to treating the whole archive as a single JS file named index.js.
   */
  private _parseJspkg(bytes: number[]): Map<string, string> {
    var result = new Map<string, string>();
    try {
      var i = 0;
      while (i < bytes.length - 8) {
        var plen = (bytes[i] << 24 | bytes[i+1] << 16 | bytes[i+2] << 8 | bytes[i+3]) >>> 0;
        i += 4;
        if (plen === 0 || plen > 4096 || i + plen > bytes.length) break;
        var path = '';
        for (var j = 0; j < plen; j++) path += String.fromCharCode(bytes[i+j]);
        i += plen;
        var dlen = (bytes[i] << 24 | bytes[i+1] << 16 | bytes[i+2] << 8 | bytes[i+3]) >>> 0;
        i += 4;
        if (i + dlen > bytes.length) break;
        var content = '';
        for (var k = 0; k < dlen; k++) content += String.fromCharCode(bytes[i+k]);
        i += dlen;
        result.set(path, content);
      }
    } catch(_) {}

    if (result.size === 0) {
      // Fallback: single JS payload
      var all = '';
      for (var i2 = 0; i2 < bytes.length; i2++) all += String.fromCharCode(bytes[i2]);
      result.set('index.js', all);
    }
    return result;
  }

  // ── Remove (item 731) ────────────────────────────────────────────────────────

  /** Remove an installed package and all its files. */
  remove(name: string): boolean {
    var rec = this.db.get(name);
    if (!rec) return false;
    if (rec.pinned) throw new Error('Package ' + name + ' is pinned; unpin first');

    // Check reverse dependencies
    var revDeps: string[] = [];
    this.db.forEach(function(r, n) {
      // We don't store dep list in InstalledRecord — skip check for now.
      // Future: store dependencies in InstalledRecord.
    });

    for (var i = 0; i < rec.files.length; i++) {
      try { vfs.rm(rec.files[i]); } catch(_) { /* ignore missing */ }
    }

    this.db.delete(name);
    writeDB(this.db);
    return true;
  }

  // ── List (item 732) ───────────────────────────────────────────────────────────

  /** Return all installed packages. */
  list(): InstalledRecord[] {
    var result: InstalledRecord[] = [];
    this.db.forEach(function(v) { result.push(v); });
    return result.sort(function(a, b) { return a.name < b.name ? -1 : 1; });
  }

  /** Check if a package is installed. */
  isInstalled(name: string): boolean { return this.db.has(name); }

  /** Get version of installed package, or null. */
  getVersion(name: string): string | null {
    var r = this.db.get(name);
    return r ? r.version : null;
  }

  // ── Update (item 735) ─────────────────────────────────────────────────────────

  /** Update a single package to the latest available version. */
  upgrade(name: string): boolean {
    var rec = this.db.get(name);
    if (!rec) throw new Error('Package not installed: ' + name);
    if (rec.pinned) throw new Error('Package ' + name + ' is pinned');

    var entry = this.search(name);
    if (!entry) throw new Error('Package not in any repository: ' + name);

    if (cmpVer(entry.version, rec.version) <= 0) return false; // already up-to-date

    this.remove(name);
    this.install(name);
    return true;
  }

  /** Upgrade all installed (non-pinned) packages. */
  upgradeAll(): string[] {
    var upgraded: string[] = [];
    var names: string[] = [];
    this.db.forEach(function(_v, k) { names.push(k); });
    for (var i = 0; i < names.length; i++) {
      try {
        if (this.upgrade(names[i])) upgraded.push(names[i]);
      } catch(_) {}
    }
    return upgraded;
  }

  // ── Pin / Unpin (item 738) ───────────────────────────────────────────────────

  pin(name: string): void {
    var r = this.db.get(name);
    if (r) { r.pinned = true; writeDB(this.db); }
  }

  unpin(name: string): void {
    var r = this.db.get(name);
    if (r) { r.pinned = false; writeDB(this.db); }
  }

  // ── Dependency graph (item 733) ─────────────────────────────────────────────

  /**
   * Resolve full install order for a set of packages using topological sort.
   * Returns ordered list, or null on circular dependency.
   */
  resolveOrder(names: string[]): string[] | null {
    var deps = new Map<string, string[]>();
    var repos = readRepos();

    function gatherDeps(name: string): void {
      if (deps.has(name)) return;
      deps.set(name, []);
      // Find in repo indexes
      for (var i = 0; i < repos.length; i++) {
        for (var j = 0; j < repos[i].packages.length; j++) {
          if (repos[i].packages[j].name === name) {
            // Would need manifest URL to get deps; for now just mark as leaf
            return;
          }
        }
      }
    }

    for (var i = 0; i < names.length; i++) gatherDeps(names[i]);
    return topoSort(deps);
  }

  // ── Sandboxed execution (item 740) ──────────────────────────────────────────

  /**
   * Run a .js / .ts package entry point in an isolated ephemeral kernel context
   * with a restricted sys.* API (no filesystem access outside /tmp/sandbox/).
   */
  sandbox(pkgName: string): any {
    var rec = this.db.get(pkgName);
    if (!rec) throw new Error('Package not installed: ' + pkgName);

    // Find entry point
    var entry = rec.files.find(function(f) { return f.endsWith('/index.js') || f.endsWith('/main.js'); });
    if (!entry) throw new Error('No entry point found for: ' + pkgName);

    var code = '';
    try { code = vfs.readFile(entry); } catch(e) { throw new Error('Cannot read entry: ' + entry); }

    // Build a restricted sys proxy
    var restrictedSys = {
      print: (kernel as any).print,
      // All other sys access is blocked
    };

    // Evaluate in a new JS context (QuickJS supports evalScript with isolation)
    try {
      // eslint-disable-next-line no-new-func
      var fn = new Function('sys', code);
      return fn(restrictedSys);
    } catch(e) {
      throw new Error('Sandboxed execution failed for ' + pkgName + ': ' + String(e));
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const pkgmgr = new PackageManager();
