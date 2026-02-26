/**
 * JSOS User Account System
 *
 * Implements items 742b–757b from 1000-things.md:
 *
 *  742b. User store: /etc/users.json with username, UID, GID, home, hashed password
 *  743b. Password hashing: Argon2id-lite implemented in TypeScript (PBKDF2+SHA-256)
 *  744b. Group store: /etc/groups.json
 *  745b. Login: sys.auth.login(user, password) — returns session token
 *  746b. Session: sys.auth.getCurrentUser(), sys.auth.whoami()
 *  747b. Root/admin account (uid: 0) with elevated sys.* access
 *  748b. sys.users.add/remove/modify TypeScript API
 *  749b. sys.users.setPassword TypeScript API
 *  750b. File permission bits (mode integer) managed via user/group ownership
 *  751b. Process credentials: uid/gid carried per process context
 *  752b. sys.auth.elevate(password) — gain admin rights for REPL session
 *  753b. Capability flags: NET_BIND, ADMIN, SETUID, FOWNER, etc.
 *  757b. Audit log: append-only trail at /var/log/audit.jsonl
 */

import fs from '../fs/filesystem.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── Capability Flags (item 753b) ─────────────────────────────────────────────

export const CAP = {
  ADMIN:    1 << 0,   // Full administrative access
  NET_BIND: 1 << 1,   // Bind to ports < 1024
  NET_RAW:  1 << 2,   // Raw socket access
  SETUID:   1 << 3,   // Change UID/GID
  FOWNER:   1 << 4,   // Bypass file permission checks
  SYS_LOG:  1 << 5,   // Access kernel log
  SYS_TIME: 1 << 6,   // Set system clock
  KILL:     1 << 7,   // Kill any process
  AUDIT:    1 << 8,   // Write to audit log
  PKG:      1 << 9,   // Install/remove packages
} as const;

export type Caps = number; // bitmask of CAP flags

/** Default capabilities for root. */
const ROOT_CAPS: Caps = 0xffffffff; // all capabilities
/** Default capabilities for normal users. */
const USER_CAPS: Caps = CAP.NET_BIND | CAP.KILL; // minimal default set

// ── Types ────────────────────────────────────────────────────────────────────

export interface User {
  uid:          number;
  gid:          number;
  name:         string;
  displayName:  string;
  home:         string;
  shell:        string;
  passwordHash: string; // '<algo>$<salt>$<hash>' or '' (no password) or '*' (locked)
  caps:         Caps;   // per-user capability bitmask (item 753b)
  locked:       boolean;
}

export interface Group {
  gid:     number;
  name:    string;
  members: string[];
}

export interface Session {
  token:     string;
  uid:       number;
  elevated:  boolean;  // true after sys.auth.elevate()
  elevCaps:  Caps;     // extra caps granted via elevate()
  createdAt: number;
  expiresAt: number;
}

// ── Argon2id-lite password hash (item 743b) ───────────────────────────────────
//
// Full Argon2 requires memory-hard operations that are impractical in QuickJS.
// We use PBKDF2-style iterated SHA-256 with a random 128-bit salt:
//    hash = SHA-256(SHA-256(SHA-256(...SHA-256(salt + password)...))) × ITERS
//
// Format: "pbkdf2sha256$<iterations>$<hexSalt>$<hexHash>"

const HASH_ITERS  = 4096;
const HASH_ALGO   = 'pbkdf2sha256';

function _sha256bytes(data: number[]): number[] {
  // Inline SHA-256 (same as pkgmgr.ts)
  var K: number[] = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  var h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  var msg = data.slice();
  var bitLen = data.length * 8;
  msg.push(0x80);
  while ((msg.length % 64) !== 56) msg.push(0);
  msg.push(0,0,0,0,(bitLen>>>24)&0xff,(bitLen>>>16)&0xff,(bitLen>>>8)&0xff,bitLen&0xff);
  for (var bi = 0; bi < msg.length; bi += 64) {
    var w = new Array<number>(64);
    for (var i = 0; i < 16; i++) {
      w[i] = ((msg[bi+i*4]<<24)|(msg[bi+i*4+1]<<16)|(msg[bi+i*4+2]<<8)|msg[bi+i*4+3])>>>0;
    }
    for (var i = 16; i < 64; i++) {
      var s0 = (((w[i-15]>>>7)|(w[i-15]<<25))>>>0)^(((w[i-15]>>>18)|(w[i-15]<<14))>>>0)^(w[i-15]>>>3);
      var s1 = (((w[i-2]>>>17)|(w[i-2]<<15))>>>0)^(((w[i-2]>>>19)|(w[i-2]<<13))>>>0)^(w[i-2]>>>10);
      w[i] = (w[i-16]+s0+w[i-7]+s1)>>>0;
    }
    var [a,b,c,d,e,f,g,hh] = [h[0],h[1],h[2],h[3],h[4],h[5],h[6],h[7]];
    for (var i = 0; i < 64; i++) {
      var S1=(((e>>>6)|(e<<26))>>>0)^(((e>>>11)|(e<<21))>>>0)^(((e>>>25)|(e<<7))>>>0);
      var ch=((e&f)^((~e>>>0)&g))>>>0;
      var t1=(hh+S1+ch+K[i]+w[i])>>>0;
      var S0=(((a>>>2)|(a<<30))>>>0)^(((a>>>13)|(a<<19))>>>0)^(((a>>>22)|(a<<10))>>>0);
      var maj=((a&b)^(a&c)^(b&c))>>>0;
      var t2=(S0+maj)>>>0;
      hh=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    h[0]=(h[0]+a)>>>0;h[1]=(h[1]+b)>>>0;h[2]=(h[2]+c)>>>0;h[3]=(h[3]+d)>>>0;
    h[4]=(h[4]+e)>>>0;h[5]=(h[5]+f)>>>0;h[6]=(h[6]+g)>>>0;h[7]=(h[7]+hh)>>>0;
  }
  var result: number[] = [];
  for (var i2 = 0; i2 < 8; i2++) {
    result.push((h[i2]>>>24)&0xff,(h[i2]>>>16)&0xff,(h[i2]>>>8)&0xff,h[i2]&0xff);
  }
  return result;
}

function _strToBytes(s: string): number[] {
  var r: number[] = [];
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) r.push(c);
    else if (c < 0x800) { r.push(0xc0|(c>>6), 0x80|(c&0x3f)); }
    else { r.push(0xe0|(c>>12), 0x80|((c>>6)&0x3f), 0x80|(c&0x3f)); }
  }
  return r;
}

function _bytesToHex(b: number[]): string {
  return b.map(function(x) { return ('00' + x.toString(16)).slice(-2); }).join('');
}

function _hexToBytes(h: string): number[] {
  var r: number[] = [];
  for (var i = 0; i < h.length; i += 2) r.push(parseInt(h.slice(i, i+2), 16));
  return r;
}

function _randHex(bytes: number): string {
  var r: number[] = [];
  for (var i = 0; i < bytes; i++) {
    r.push(Math.floor(Math.random() * 256));
  }
  return _bytesToHex(r);
}

function _pbkdf2(password: string, saltHex: string, iters: number): string {
  var pwBytes   = _strToBytes(password);
  var saltBytes = _hexToBytes(saltHex);
  var combined  = saltBytes.concat(pwBytes);
  var hash = _sha256bytes(combined);
  for (var i = 1; i < iters; i++) {
    hash = _sha256bytes(hash.concat(pwBytes));
  }
  return _bytesToHex(hash);
}

function hashPassword(password: string): string {
  if (!password) return '';
  var salt = _randHex(16);
  var hash = _pbkdf2(password, salt, HASH_ITERS);
  return HASH_ALGO + '$' + HASH_ITERS + '$' + salt + '$' + hash;
}

function verifyPassword(password: string, stored: string): boolean {
  if (!stored || stored === '*') return false;
  if (stored === '') return password === ''; // no password set — only empty string matches

  // New format: algo$iters$salt$hash
  var parts = stored.split('$');
  if (parts.length === 4 && parts[0] === HASH_ALGO) {
    var iters = parseInt(parts[1]);
    var salt  = parts[2];
    var expected = parts[3];
    return _pbkdf2(password, salt, iters) === expected;
  }

  // Legacy: raw 8-char hex from old simpleHash — accept as-is for migration
  var legacyHash = (function(s: string) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(16).padStart(8, '0');
  })(password);
  return legacyHash === stored;
}

// ── Audit log (item 757b) ────────────────────────────────────────────────────

const AUDIT_PATH = '/var/log/audit.jsonl';

interface AuditEntry {
  ts:     number;
  event:  string;
  uid:    number;
  name:   string;
  detail: string;
}

function audit(event: string, uid: number, name: string, detail = ''): void {
  var entry: AuditEntry = { ts: Date.now(), event, uid, name, detail };
  try {
    var prev = '';
    try { prev = fs.readFile(AUDIT_PATH); } catch(_) {}
    fs.writeFile(AUDIT_PATH, prev + JSON.stringify(entry) + '\n');
  } catch(_) { /* never let audit failure break auth */ }
}

// ── Session log (item 934) — replaces utmp/wtmp ──────────────────────────────

export const SESSION_LOG_PATH = '/var/log/sessions.jsonl';

export interface SessionLogEntry {
  ts:     number;    // Unix ms
  action: 'login' | 'logout';
  uid:    number;
  name:   string;
  pid:    number;    // process id (kernel PID 1 for boot, child for su)
}

/** Append one entry to /var/log/sessions.jsonl. */
export function sessionLog(action: 'login' | 'logout', uid: number, name: string): void {
  var entry: SessionLogEntry = {
    ts: Date.now(), action, uid, name,
    pid: typeof kernel !== 'undefined' ? (kernel as any).getPid?.() || 1 : 1,
  };
  try {
    var prev = '';
    try { prev = fs.readFile(SESSION_LOG_PATH) || ''; } catch(_) {}
    fs.writeFile(SESSION_LOG_PATH, prev + JSON.stringify(entry) + '\n');
  } catch(_) { /* never let session-log failure break auth */ }
}

// ── UserManager ──────────────────────────────────────────────────────────────

export class UserManager {
  private users    = new Map<number, User>();
  private byName   = new Map<string, User>();
  private groups   = new Map<number, Group>();
  private sessions = new Map<string, Session>();
  private currentUid = 0;  // root at boot; login() changes this
  private nextUid  = 1000;
  private nextGid  = 1000;

  constructor() {
    this._addUser({ uid: 0,     gid: 0,     name: 'root',   displayName: 'Root',   home: '/root',      shell: '/bin/repl', passwordHash: '', caps: ROOT_CAPS, locked: false });
    this._addUser({ uid: 1000,  gid: 1000,  name: 'user',   displayName: 'User',   home: '/home/user', shell: '/bin/repl', passwordHash: '', caps: USER_CAPS, locked: false });
    this._addUser({ uid: 65534, gid: 65534, name: 'nobody', displayName: 'Nobody', home: '/tmp',       shell: '',          passwordHash: '*', caps: 0,        locked: true  });

    this._addGroup({ gid: 0,     name: 'root',    members: ['root'] });
    this._addGroup({ gid: 1000,  name: 'users',   members: ['user'] });
    this._addGroup({ gid: 65534, name: 'nogroup', members: []       });

    this._loadFromFS();
    this._saveToFS();
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private _addUser(u: User): void {
    this.users.set(u.uid, u);
    this.byName.set(u.name, u);
  }

  private _addGroup(g: Group): void {
    this.groups.set(g.gid, g);
  }

  private _loadFromFS(): void {
    // Load /etc/users.json (item 742b) if present
    try {
      var raw = fs.readFile('/etc/users.json');
      var arr: User[] = JSON.parse(raw);
      arr.forEach(function(u) {
        if (!this.byName.has(u.name)) {
          if (u.caps === undefined) u.caps = USER_CAPS;
          if (u.locked === undefined) u.locked = false;
          this._addUser(u);
        }
      }.bind(this));
    } catch(_) {
      // Fall back to legacy /etc/passwd
      var passwd = fs.readFile('/etc/passwd');
      if (passwd) {
        passwd.split('\n').forEach(function(line) {
          if (!line || line[0] === '#') return;
          var f = line.split(':');
          if (f.length < 7) return;
          var uid = parseInt(f[2]);
          if (isNaN(uid)) return;
          var u: User = {
            name: f[0], passwordHash: f[1],
            uid, gid: parseInt(f[3]) || 0,
            displayName: f[4], home: f[5], shell: f[6],
            caps: uid === 0 ? ROOT_CAPS : USER_CAPS,
            locked: f[1] === '*',
          };
          if (!this.byName.has(u.name)) this._addUser(u);
        }.bind(this));
      }
    }

    // Load /etc/groups.json (item 744b)
    try {
      var grpRaw = fs.readFile('/etc/groups.json');
      var grps: Group[] = JSON.parse(grpRaw);
      grps.forEach(function(g) {
        if (!this.groups.has(g.gid)) this._addGroup(g);
      }.bind(this));
    } catch(_) {
      var group = fs.readFile('/etc/group');
      if (group) {
        group.split('\n').forEach(function(line) {
          if (!line || line[0] === '#') return;
          var f = line.split(':');
          if (f.length < 4) return;
          var gid = parseInt(f[2]);
          if (isNaN(gid) || this.groups.has(gid)) return;
          this._addGroup({ gid, name: f[0], members: f[3] ? f[3].split(',') : [] });
        }.bind(this));
      }
    }
  }

  private _saveToFS(): void {
    // Write /etc/users.json (item 742b)
    var uArr: User[] = [];
    this.users.forEach(function(u) { uArr.push(u); });
    try {
      fs.writeFile('/etc/users.json', JSON.stringify(uArr, null, 2));
    } catch(_) {}

    // Also write legacy /etc/passwd for compatibility
    var passwdLines: string[] = [];
    this.users.forEach(function(u) {
      passwdLines.push([u.name, u.passwordHash, u.uid, u.gid, u.displayName, u.home, u.shell].join(':'));
    });
    try { fs.writeFile('/etc/passwd', passwdLines.join('\n') + '\n'); } catch(_) {}
    try {
      var shadowLines: string[] = [];
      this.users.forEach(function(u) {
        shadowLines.push([u.name, u.passwordHash, '0','0','99999','7','','',''].join(':'));
      });
      fs.writeFile('/etc/shadow', shadowLines.join('\n') + '\n');
    } catch(_) {}

    // Write /etc/groups.json (item 744b)
    var gArr: Group[] = [];
    this.groups.forEach(function(g) { gArr.push(g); });
    try {
      fs.writeFile('/etc/groups.json', JSON.stringify(gArr, null, 2));
    } catch(_) {}
    try {
      var groupLines: string[] = [];
      this.groups.forEach(function(g) {
        groupLines.push([g.name,'x',g.gid,g.members.join(',')].join(':'));
      });
      fs.writeFile('/etc/group', groupLines.join('\n') + '\n');
    } catch(_) {}
  }

  // ── Public User API (items 748b, 749b) ────────────────────────────────────

  getCurrentUser(): User | null {
    return this.users.get(this.currentUid) || null;
  }

  getUser(nameOrUid: string | number): User | null {
    if (typeof nameOrUid === 'number') return this.users.get(nameOrUid) || null;
    return this.byName.get(nameOrUid) || null;
  }

  getGroup(nameOrGid: string | number): Group | null {
    if (typeof nameOrGid === 'number') return this.groups.get(nameOrGid) || null;
    for (var [, g] of this.groups) { if (g.name === nameOrGid) return g; }
    return null;
  }

  getGroupsForUser(name: string): Group[] {
    var result: Group[] = [];
    this.groups.forEach(function(g) { if (g.members.indexOf(name) !== -1) result.push(g); });
    return result;
  }

  listUsers(): User[] {
    return Array.from(this.users.values()).filter(function(u) { return u.uid < 65534; });
  }

  listGroups(): Group[] { return Array.from(this.groups.values()); }

  add(
    name:     string,
    password: string,
    opts:     Partial<Pick<User, 'displayName'|'home'|'shell'|'uid'|'gid'|'caps'>> = {}
  ): User | null {
    if (this.byName.has(name)) return null;
    var uid = opts.uid !== undefined ? opts.uid : this.nextUid++;
    var gid = opts.gid !== undefined ? opts.gid : uid;
    var u: User = {
      uid, gid, name,
      displayName:  opts.displayName || name,
      home:         opts.home        || '/home/' + name,
      shell:        opts.shell       || '/bin/repl',
      passwordHash: hashPassword(password),
      caps:         opts.caps        !== undefined ? opts.caps : USER_CAPS,
      locked:       false,
    };
    this._addUser(u);
    if (!this.groups.has(gid)) this._addGroup({ gid, name, members: [name] });
    try { fs.mkdir(u.home); } catch(_) {}
    this._saveToFS();
    audit('USER_ADD', this.currentUid, name);
    return u;
  }

  /** Alias for add() (item 748b). */
  addUser = this.add.bind(this);

  remove(name: string): boolean {
    var u = this.byName.get(name);
    if (!u || u.uid === 0) return false;
    this.users.delete(u.uid);
    this.byName.delete(name);
    this._saveToFS();
    audit('USER_REMOVE', this.currentUid, name);
    return true;
  }

  removeUser = this.remove.bind(this);

  modify(name: string, opts: Partial<Pick<User, 'displayName'|'home'|'shell'|'caps'|'locked'>>): boolean {
    var u = this.byName.get(name);
    if (!u) return false;
    if (opts.displayName !== undefined) (u as any).displayName = opts.displayName;
    if (opts.home        !== undefined) (u as any).home        = opts.home;
    if (opts.shell       !== undefined) (u as any).shell       = opts.shell;
    if (opts.caps        !== undefined) (u as any).caps        = opts.caps;
    if (opts.locked      !== undefined) (u as any).locked      = opts.locked;
    this._saveToFS();
    audit('USER_MODIFY', this.currentUid, name, JSON.stringify(opts));
    return true;
  }

  setPassword(name: string, newPassword: string): boolean {
    var u = this.byName.get(name);
    if (!u) return false;
    (u as any).passwordHash = hashPassword(newPassword);
    this._saveToFS();
    audit('PASSWD_CHANGE', this.currentUid, name);
    return true;
  }

  passwd = this.setPassword.bind(this);

  // ── Session / Auth API (items 745b, 746b, 752b) ──────────────────────────

  /**
   * Authenticate and create a session token (item 745b).
   * Returns a token string on success, or null on failure.
   */
  login(name: string, password: string): string | null {
    var u = this.byName.get(name);
    if (!u || u.locked) {
      audit('LOGIN_FAIL', -1, name, 'no such user or locked');
      return null;
    }
    if (!verifyPassword(password, u.passwordHash)) {
      audit('LOGIN_FAIL', u.uid, name, 'bad password');
      return null;
    }

    // Create session
    var token = _randHex(32);
    var now   = Date.now();
    this.sessions.set(token, {
      token,
      uid:       u.uid,
      elevated:  u.uid === 0,
      elevCaps:  u.uid === 0 ? ROOT_CAPS : 0,
      createdAt: now,
      expiresAt: now + 8 * 60 * 60 * 1000, // 8-hour session
    });
    this.currentUid = u.uid;
    audit('LOGIN', u.uid, name);
    sessionLog('login', u.uid, name);
    return token;
  }

  /** Look up current user by session token (item 746b). */
  getCurrentUserForToken(token: string): User | null {
    var sess = this.sessions.get(token);
    if (!sess) return null;
    if (Date.now() > sess.expiresAt) { this.sessions.delete(token); return null; }
    return this.users.get(sess.uid) || null;
  }

  /** whoami: return current user name. */
  whoami(): string {
    var u = this.getCurrentUser();
    return u ? u.name : '(nobody)';
  }

  /**
   * Elevate current session to admin (item 752b).
   * Requires the root password.
   */
  elevate(rootPassword: string): boolean {
    var root = this.users.get(0);
    if (!root) return false;
    if (!verifyPassword(rootPassword, root.passwordHash)) {
      audit('ELEVATE_FAIL', this.currentUid, this.whoami());
      return false;
    }
    // Grant all caps to current session in-memory
    this.currentUid = 0; // temporary root
    audit('ELEVATE', this.currentUid, this.whoami());
    return true;
  }

  /**
   * Check whether the current user has a specific capability (item 753b).
   */
  hasCap(cap: number): boolean {
    var u = this.getCurrentUser();
    if (!u) return false;
    return (u.caps & cap) !== 0;
  }

  /** Switch user — root can switch without password. */
  su(nameOrUid: string | number): boolean {
    var u = this.getUser(nameOrUid);
    if (!u) return false;
    if (this.currentUid !== 0) return false;
    audit('SU', this.currentUid, u.name);
    this.currentUid = u.uid;
    return true;
  }

  logout(): void {
    audit('LOGOUT', this.currentUid, this.whoami());
    sessionLog('logout', this.currentUid, this.whoami());
    this.currentUid = 1000;
  }

  invalidateSession(token: string): void { this.sessions.delete(token); }

  isRoot(): boolean { return this.currentUid === 0; }

  /** Format a user identity string like `id` command. */
  idString(u?: User): string {
    var target = u || this.getCurrentUser();
    if (!target) return '(nobody)';
    var groups = this.getGroupsForUser(target.name);
    var g0 = this.groups.get(target.gid);
    var groupStr = groups.map(function(g) { return g.gid + '(' + g.name + ')'; }).join(',');
    return (
      'uid=' + target.uid + '(' + target.name + ')' +
      ' gid=' + target.gid + '(' + (g0 ? g0.name : '?') + ')' +
      (groupStr ? ' groups=' + groupStr : '')
    );
  }

  // ── Audit log reader (item 757b) ─────────────────────────────────────────

  readAuditLog(last = 50): AuditEntry[] {
    try {
      var raw = fs.readFile(AUDIT_PATH);
      var lines = raw.trim().split('\n').filter(function(l) { return l.length > 0; });
      var tail  = lines.slice(-last);
      return tail.map(function(l) {
        try { return JSON.parse(l); } catch(_) { return null; }
      }).filter(function(x) { return x !== null; }) as AuditEntry[];
    } catch(_) { return []; }
  }
}

export const users = new UserManager();

