/**
 * JSOS Mandatory Access Control (MAC) Policy Engine
 *
 * [Item 758b] Typed policy engine for mandatory access control.
 *
 * Implements a label-based MAC system inspired by SELinux/AppArmor concepts,
 * adapted for JSOS's TypeScript process model.
 *
 * Key concepts:
 *  - Every subject (process) has a security label (domain)
 *  - Every object (file, socket, IPC) has a security label (type)
 *  - Access is allowed only if there is an explicit allow rule (deny-by-default)
 *  - Rules are loaded from /etc/mac.policy (JSON lines format)
 *
 * Usage:
 *   macPolicy.defineLabel('sshd_t',  { description: 'SSH daemon process' });
 *   macPolicy.defineLabel('etc_t',   { description: '/etc files' });
 *   macPolicy.allow('sshd_t', 'etc_t', ['read', 'getattr']);
 *   macPolicy.check(sshPid, '/etc/passwd', 'read');  // true
 *   macPolicy.check(sshPid, '/etc/shadow', 'write'); // false (not allowed)
 */

declare var kernel: import('../core/kernel.js').KernelAPI;

export type MACLabel = string;
export type MACPermission = 'read' | 'write' | 'execute' | 'create' | 'delete'
                          | 'connect' | 'send' | 'recv' | 'ioctl' | 'getattr'
                          | 'setattr' | 'fork' | 'signal' | 'bind' | 'accept'
                          | string;

export interface MACLabelDef {
  name: MACLabel;
  description?: string;
  /** If true, processes with this label are trusted (superuser equivalent). */
  trusted?: boolean;
}

export interface MACRule {
  subject: MACLabel;      /** Source domain (process label) */
  object: MACLabel;       /** Target type (file/socket/IPC label) */
  permissions: Set<MACPermission>;
}

export interface MACCheckResult {
  allowed: boolean;
  reason: string;
  rule?: MACRule;
}

export interface MACViolation {
  timestamp: number;
  pid: number;
  subject: MACLabel;
  object: MACLabel;
  permission: MACPermission;
  targetPath?: string;
}

/**
 * [Item 758b] MAC policy engine — deny-by-default, label-based access control.
 */
export class MACPolicyEngine {
  private _labels:    Map<string, MACLabelDef> = new Map();
  private _rules:     MACRule[] = [];
  private _pidLabels: Map<number, MACLabel> = new Map();
  private _pathLabels: Map<string, MACLabel> = new Map();
  private _violations: MACViolation[] = [];
  private _enforcing: boolean = true;
  private _maxViolations: number = 1000;

  // ── Label management ────────────────────────────────────────────────────────

  /** Define a MAC label/domain. */
  defineLabel(name: MACLabel, def: Omit<MACLabelDef, 'name'> = {}): void {
    this._labels.set(name, { name, ...def });
  }

  /** Assign a security label to a process by PID. */
  labelProcess(pid: number, label: MACLabel): void {
    this._ensureLabel(label);
    this._pidLabels.set(pid, label);
  }

  /** Remove the label for a terminated process. */
  unlabelProcess(pid: number): void { this._pidLabels.delete(pid); }

  /** Get the label for a process. Returns 'unconfined_t' if not set. */
  processLabel(pid: number): MACLabel {
    return this._pidLabels.get(pid) ?? 'unconfined_t';
  }

  /** Assign a security label to a filesystem path (prefix match). */
  labelPath(path: string, label: MACLabel): void {
    this._ensureLabel(label);
    this._pathLabels.set(path, label);
  }

  /** Get the label for a filesystem path (longest prefix match). */
  pathLabel(path: string): MACLabel {
    var best = '';
    var bestLabel = 'unlabeled_t';
    this._pathLabels.forEach(function(lbl, pfx) {
      if (path.startsWith(pfx) && pfx.length > best.length) {
        best = pfx; bestLabel = lbl;
      }
    });
    return bestLabel;
  }

  // ── Rule management ─────────────────────────────────────────────────────────

  /**
   * [Item 758b] Add an allow rule: subject domain → object type → permissions.
   */
  allow(subject: MACLabel, object: MACLabel, permissions: MACPermission[]): void {
    this._ensureLabel(subject);
    this._ensureLabel(object);
    // Merge with existing rule if one exists
    var existing = this._rules.find(function(r) {
      return r.subject === subject && r.object === object;
    });
    if (existing) {
      permissions.forEach(function(p) { existing!.permissions.add(p); });
    } else {
      this._rules.push({ subject, object, permissions: new Set(permissions) });
    }
  }

  /** Remove specific permissions from a rule. */
  deny(subject: MACLabel, object: MACLabel, permissions: MACPermission[]): void {
    var rule = this._rules.find(function(r) {
      return r.subject === subject && r.object === object;
    });
    if (!rule) return;
    permissions.forEach(function(p) { rule!.permissions.delete(p); });
    if (rule.permissions.size === 0) {
      this._rules = this._rules.filter(function(r) { return r !== rule; });
    }
  }

  /** Remove all rules for a subject domain. */
  removeSubjectRules(subject: MACLabel): void {
    this._rules = this._rules.filter(function(r) { return r.subject !== subject; });
  }

  // ── Access checking ─────────────────────────────────────────────────────────

  /**
   * [Item 758b] Check if a process (by PID) may perform `permission` on `objectPath`.
   * In enforcing mode, violations are logged and false is returned.
   * In permissive mode, violations are logged but true is returned.
   */
  check(pid: number, objectPath: string, permission: MACPermission): boolean {
    var subject = this.processLabel(pid);
    var object  = this.pathLabel(objectPath);
    var result  = this.checkLabels(subject, object, permission);
    if (!result.allowed) {
      this._logViolation(pid, subject, object, permission, objectPath);
    }
    return this._enforcing ? result.allowed : true;
  }

  /**
   * Check by explicit labels (bypasses PID/path resolution).
   */
  checkLabels(subject: MACLabel, object: MACLabel, permission: MACPermission): MACCheckResult {
    // Trusted subjects pass all checks
    var subjectDef = this._labels.get(subject);
    if (subjectDef?.trusted) return { allowed: true, reason: 'trusted domain' };

    // unconfined_t passes all (like root in permissive mode)
    if (subject === 'unconfined_t') return { allowed: true, reason: 'unconfined' };

    // Find matching rule
    var rule = this._rules.find(function(r) {
      return r.subject === subject && r.object === object && r.permissions.has(permission);
    });
    if (rule) return { allowed: true, reason: 'allow rule matched', rule };

    // Wildcard object type
    var wildRule = this._rules.find(function(r) {
      return r.subject === subject && r.object === '*' && r.permissions.has(permission);
    });
    if (wildRule) return { allowed: true, reason: 'wildcard allow rule', rule: wildRule };

    return { allowed: false, reason: 'no allow rule for ' + subject + ':' + object + ':' + permission };
  }

  // ── Policy load/save ────────────────────────────────────────────────────────

  /** Load a policy from a JSON string (newline-delimited JSON objects). */
  loadPolicy(json: string): number {
    var loaded = 0;
    json.split('\n').filter(Boolean).forEach((line: string) => {
      try {
        var entry: any = JSON.parse(line);
        if (entry.type === 'label') {
          this.defineLabel(entry.name, { description: entry.description, trusted: entry.trusted });
        } else if (entry.type === 'allow') {
          this.allow(entry.subject, entry.object, entry.permissions);
        } else if (entry.type === 'path') {
          this.labelPath(entry.path, entry.label);
        }
        loaded++;
      } catch (_) {}
    });
    return loaded;
  }

  /** Export current policy as NDJSON. */
  exportPolicy(): string {
    var lines: string[] = [];
    this._labels.forEach(function(l) {
      lines.push(JSON.stringify({ type: 'label', name: l.name, description: l.description, trusted: l.trusted }));
    });
    this._pathLabels.forEach(function(lbl, path) {
      lines.push(JSON.stringify({ type: 'path', path, label: lbl }));
    });
    this._rules.forEach(function(r) {
      lines.push(JSON.stringify({ type: 'allow', subject: r.subject, object: r.object, permissions: Array.from(r.permissions) }));
    });
    return lines.join('\n') + '\n';
  }

  /** Load policy from /etc/mac.policy on the kernel VFS. */
  loadFromDisk(): number {
    try {
      var content = (kernel as any).fs?.readFile('/etc/mac.policy') ?? '';
      return content ? this.loadPolicy(content) : 0;
    } catch (_) { return 0; }
  }

  // ── Mode & monitoring ───────────────────────────────────────────────────────

  /** Switch between enforcing and permissive mode. */
  setEnforcing(v: boolean): void { this._enforcing = v; }

  get isEnforcing(): boolean { return this._enforcing; }

  violations(): MACViolation[] { return this._violations.slice(); }

  clearViolations(): void { this._violations = []; }

  listLabels(): MACLabelDef[] {
    var arr: MACLabelDef[] = [];
    this._labels.forEach(function(l) { arr.push(l); });
    return arr;
  }

  listRules(): Array<{ subject: string; object: string; permissions: string[] }> {
    return this._rules.map(function(r) {
      return { subject: r.subject, object: r.object, permissions: Array.from(r.permissions) };
    });
  }

  private _ensureLabel(name: MACLabel): void {
    if (!this._labels.has(name)) this._labels.set(name, { name });
  }

  private _logViolation(pid: number, subject: MACLabel, object: MACLabel, permission: MACPermission, path?: string): void {
    if (this._violations.length >= this._maxViolations) this._violations.shift();
    this._violations.push({
      timestamp: kernel.getTicks(),
      pid, subject, object, permission,
      targetPath: path,
    });
  }
}

/** Singleton MAC policy engine. */
export const macPolicy = new MACPolicyEngine();

// ── Built-in JSOS default policy ──────────────────────────────────────────────

// Define core domains and types
macPolicy.defineLabel('kernel_t',    { description: 'Kernel domain',        trusted: true });
macPolicy.defineLabel('init_t',      { description: 'Init process domain',  trusted: true });
macPolicy.defineLabel('unconfined_t',{ description: 'Unconfined (root)',    trusted: true });
macPolicy.defineLabel('user_t',      { description: 'Unprivileged user process' });
macPolicy.defineLabel('sshd_t',      { description: 'SSH daemon' });
macPolicy.defineLabel('httpd_t',     { description: 'HTTP server' });
macPolicy.defineLabel('repl_t',      { description: 'REPL process' });

// File types
macPolicy.defineLabel('etc_t',       { description: '/etc files' });
macPolicy.defineLabel('var_t',       { description: '/var files' });
macPolicy.defineLabel('tmp_t',       { description: '/tmp files' });
macPolicy.defineLabel('bin_t',       { description: '/bin files' });
macPolicy.defineLabel('home_t',      { description: '/home files' });
macPolicy.defineLabel('dev_t',       { description: '/dev files' });
macPolicy.defineLabel('proc_t',      { description: '/proc files' });

// Path labels
macPolicy.labelPath('/etc',   'etc_t');
macPolicy.labelPath('/var',   'var_t');
macPolicy.labelPath('/tmp',   'tmp_t');
macPolicy.labelPath('/bin',   'bin_t');
macPolicy.labelPath('/home',  'home_t');
macPolicy.labelPath('/dev',   'dev_t');
macPolicy.labelPath('/proc',  'proc_t');

// User rules: can read most things, write to /tmp and /home
macPolicy.allow('user_t', 'etc_t',  ['read', 'getattr']);
macPolicy.allow('user_t', 'bin_t',  ['read', 'execute', 'getattr']);
macPolicy.allow('user_t', 'tmp_t',  ['read', 'write', 'create', 'delete', 'getattr', 'setattr']);
macPolicy.allow('user_t', 'home_t', ['read', 'write', 'create', 'delete', 'getattr', 'setattr']);
macPolicy.allow('user_t', 'var_t',  ['read', 'getattr']);
macPolicy.allow('user_t', 'proc_t', ['read', 'getattr']);
macPolicy.allow('user_t', 'dev_t',  ['read', 'write', 'ioctl']);

// REPL rules: same as user, plus execute
macPolicy.allow('repl_t', 'etc_t',  ['read', 'getattr']);
macPolicy.allow('repl_t', 'bin_t',  ['read', 'execute', 'getattr']);
macPolicy.allow('repl_t', 'tmp_t',  ['read', 'write', 'create', 'delete', 'getattr', 'setattr']);
macPolicy.allow('repl_t', 'home_t', ['read', 'write', 'create', 'delete', 'getattr', 'setattr']);
macPolicy.allow('repl_t', 'dev_t',  ['read', 'write', 'ioctl']);

// SSHD rules
macPolicy.allow('sshd_t', 'etc_t',  ['read', 'getattr']);
macPolicy.allow('sshd_t', 'home_t', ['read', 'write', 'getattr']);
macPolicy.allow('sshd_t', 'dev_t',  ['read', 'write', 'ioctl']);
macPolicy.allow('sshd_t', 'var_t',  ['read', 'write', 'create', 'getattr', 'setattr']);

// HTTPD rules
macPolicy.allow('httpd_t', 'var_t', ['read', 'write', 'getattr']);
macPolicy.allow('httpd_t', 'tmp_t', ['read', 'write', 'create', 'getattr']);
macPolicy.allow('httpd_t', 'etc_t', ['read', 'getattr']);
