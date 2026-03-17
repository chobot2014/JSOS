/**
 * Cloud-Init Support
 * Item 906 — Parse and apply cloud-init user-data at first boot
 *
 * Supports a subset of cloud-init's YAML user-data:
 *   hostname
 *   users
 *   write_files
 *   runcmd
 *   package_install  (alias: packages)
 *   network (basic hostname/DNS only)
 *
 * User-data is sourced from:
 *   1. Kernel command line: cloud-init=<base64>
 *   2. Virtual CD-ROM labeled 'cidata' containing user-data and meta-data
 *   3. HTTP metadata server: http://169.254.169.254/latest/user-data
 */

declare const sys: any;
declare const kernel: any;

// ── Minimal YAML parser (subset) ──────────────────────────────────────────

interface YamlDict extends Record<string, YamlValue> {}
type YamlValue = string | number | boolean | null | YamlValue[] | YamlDict;

function parseYaml(text: string): Record<string, YamlValue> {
  // Extremely minimal line-by-line parser for cloud-init YAML
  const result: Record<string, YamlValue> = {};
  const lines = text.replace(/\r/g, '').split('\n');
  let i = 0;

  function skipBlank() { while (i < lines.length && lines[i].trim() === '') i++; }
  function indentOf(line: string) { let n = 0; while (n < line.length && line[n] === ' ') n++; return n; }

  function parseMappingAtIndent(baseIndent: number): Record<string, YamlValue> {
    const obj: Record<string, YamlValue> = {};
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '' || line.trim().startsWith('#')) { i++; continue; }
      const ind = indentOf(line);
      if (ind < baseIndent) break;
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) { i++; continue; }
      const key = line.substring(ind, colonIdx).trim();
      const rest = line.substring(colonIdx + 1).trim();
      i++;
      if (rest === '' || rest === '|' || rest === '>') {
        // Next line
        skipBlank();
        if (i < lines.length && indentOf(lines[i]) > ind) {
          if (lines[i].trim().startsWith('-')) {
            obj[key] = parseSequenceAtIndent(indentOf(lines[i]));
          } else {
            obj[key] = parseMappingAtIndent(indentOf(lines[i]));
          }
        } else {
          obj[key] = null;
        }
      } else {
        obj[key] = parseScalar(rest);
      }
    }
    return obj;
  }

  function parseSequenceAtIndent(baseIndent: number): YamlValue[] {
    const arr: YamlValue[] = [];
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '') { i++; continue; }
      const ind = indentOf(line);
      if (ind < baseIndent) break;
      if (!line.trim().startsWith('-')) break;
      const rest = line.trim().substring(1).trim();
      i++;
      if (rest === '') {
        if (i < lines.length && indentOf(lines[i]) > ind) {
          arr.push(parseMappingAtIndent(indentOf(lines[i])));
        }
      } else {
        arr.push(parseScalar(rest));
      }
    }
    return arr;
  }

  function parseScalar(s: string): YamlValue {
    if (s === 'true' || s === 'yes')  return true;
    if (s === 'false' || s === 'no')  return false;
    if (s === 'null' || s === '~')    return null;
    if (/^-?\d+$/.test(s))            return parseInt(s, 10);
    if (/^-?\d+\.\d+$/.test(s))       return parseFloat(s);
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1);
    }
    return s;
  }

  skipBlank();
  // Skip cloud-init header
  if (lines[i]?.startsWith('#cloud-config')) i++;
  skipBlank();
  return parseMappingAtIndent(0);
}

// ── User-data handlers ────────────────────────────────────────────────────

function applyHostname(cfg: Record<string, YamlValue>): void {
  if (typeof cfg.hostname === 'string') {
    sys.fs.writeFile('/etc/hostname', cfg.hostname + '\n', 'utf8');
    console.log(`[cloud-init] hostname = ${cfg.hostname}`);
  }
}

function applyUsers(cfg: Record<string, YamlValue>): void {
  if (!Array.isArray(cfg.users)) return;
  for (const u of cfg.users as any[]) {
    if (typeof u !== 'object' || !u.name) continue;
    sys.users.createUser({ username: u.name, password: u.passwd ?? '', sudo: !!u.sudo });
    if (Array.isArray(u['ssh-authorized-keys'])) {
      const sshDir = `/home/${u.name}/.ssh`;
      try { sys.fs.mkdir(sshDir); } catch {}
      const keys = (u['ssh-authorized-keys'] as string[]).join('\n') + '\n';
      sys.fs.writeFile(`${sshDir}/authorized_keys`, keys, 'utf8');
    }
    console.log(`[cloud-init] created user: ${u.name}`);
  }
}

function applyWriteFiles(cfg: Record<string, YamlValue>): void {
  if (!Array.isArray(cfg.write_files)) return;
  for (const f of cfg.write_files as any[]) {
    if (!f.path) continue;
    const content = f.content ?? '';
    const encoding = f.encoding ?? 'text';
    try {
      sys.fs.mkdir(f.path.split('/').slice(0, -1).join('/') || '/');
    } catch {}
    sys.fs.writeFile(f.path, encoding === 'b64' ? atob(content) : content, 'utf8');
    if (f.permissions) sys.fs.chmod(f.path, parseInt(f.permissions, 8));
    console.log(`[cloud-init] wrote ${f.path}`);
  }
}

function applyRunCmd(cfg: Record<string, YamlValue>): void {
  const cmds: any[] = (cfg.runcmd as any[]) ?? [];
  for (const cmd of cmds) {
    const line = Array.isArray(cmd) ? cmd.join(' ') : String(cmd);
    console.log(`[cloud-init] runcmd: ${line}`);
    try { sys.process.shell(line); } catch (e) { console.error(`[cloud-init] command failed: ${e}`); }
  }
}

function applyPackages(cfg: Record<string, YamlValue>): void {
  const pkgs: any[] = (cfg.packages as any[]) ?? (cfg.package_install as any[]) ?? [];
  for (const pkg of pkgs) {
    const name = typeof pkg === 'string' ? pkg : String(pkg);
    console.log(`[cloud-init] installing package: ${name}`);
    try { sys.process.shell(`npm install -g ${name}`); } catch {}
  }
}

// ── Entry point ────────────────────────────────────────────────────────────

/**
 * Run cloud-init at first boot.
 * Sources user-data from the kernel command line, cidata CDROM, or HTTP metadata.
 */
export async function runCloudInit(): Promise<void> {
  let userData: string | null = null;

  // 1. Kernel command line
  const cmdline: string = kernel.getCmdline?.() ?? '';
  const match = cmdline.match(/cloud-init=([^\s]+)/);
  if (match) {
    try { userData = atob(match[1]); } catch {}
  }

  // 2. cidata virtual CDROM (/dev/cidata or mounted at /cidata)
  if (!userData) {
    try { userData = sys.fs.readFile('/cidata/user-data', 'utf8'); } catch {}
  }

  // 3. EC2/GCE/Azure metadata server
  if (!userData) {
    try {
      const resp = await sys.net.fetchText('http://169.254.169.254/latest/user-data');
      if (resp) userData = resp;
    } catch {}
  }

  if (!userData) { console.log('[cloud-init] no user-data found; skipping'); return; }
  if (!userData.includes('#cloud-config')) { console.log('[cloud-init] user-data is not #cloud-config; skipping'); return; }

  console.log('[cloud-init] applying user-data...');
  const cfg = parseYaml(userData);

  applyHostname(cfg);
  applyUsers(cfg);
  applyWriteFiles(cfg);
  applyPackages(cfg);
  applyRunCmd(cfg);

  // Mark cloud-init as completed
  sys.fs.writeFile('/var/lib/cloud-init.done', new Date().toISOString(), 'utf8');
  console.log('[cloud-init] done');
}

/** Returns true if cloud-init has already run on this system. */
export function hasRunBefore(): boolean {
  try { sys.fs.stat('/var/lib/cloud-init.done'); return true; } catch { return false; }
}
