/**
 * JSOS User Account System
 *
 * Manages users, groups, authentication, and the current login session.
 * Persists user data to /etc/passwd and /etc/group via the in-memory
 * filesystem so scripts can read them with standard tools.
 *
 * All authentication is synchronous — no PAM, no async on bare metal.
 */

import fs from './filesystem.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface User {
  uid:          number;
  gid:          number;
  name:         string;
  displayName:  string;
  home:         string;
  shell:        string;
  passwordHash: string; // hex hash or '' (no password) or '*' (locked)
}

export interface Group {
  gid:     number;
  name:    string;
  members: string[];
}

// ── Minimal deterministic hash (suitable for bare-metal auth) ────────────────

function simpleHash(s: string): string {
  if (!s) return '';
  var h = 5381;
  for (var i = 0; i < s.length; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ── UserManager ──────────────────────────────────────────────────────────────

export class UserManager {
  private users    = new Map<number, User>();
  private byName   = new Map<string, User>();
  private groups   = new Map<number, Group>();
  private currentUid = 0;  // root at boot; login() changes this
  private nextUid  = 1000;
  private nextGid  = 1000;

  constructor() {
    // Built-in accounts — always present
    this._addUser({ uid: 0,     gid: 0,     name: 'root',   displayName: 'Root',   home: '/root',      shell: '/bin/repl', passwordHash: '' });
    this._addUser({ uid: 1000,  gid: 1000,  name: 'user',   displayName: 'User',   home: '/home/user', shell: '/bin/repl', passwordHash: '' });
    this._addUser({ uid: 65534, gid: 65534, name: 'nobody', displayName: 'Nobody', home: '/tmp',       shell: '',          passwordHash: '*' });

    this._addGroup({ gid: 0,     name: 'root',    members: ['root'] });
    this._addGroup({ gid: 1000,  name: 'users',   members: ['user'] });
    this._addGroup({ gid: 65534, name: 'nogroup', members: []        });

    this._loadFromFS();
    this._saveToFS(); // write canonical files if not present
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private _addUser(u: User): void {
    this.users.set(u.uid, u);
    this.byName.set(u.name, u);
  }

  private _addGroup(g: Group): void {
    this.groups.set(g.gid, g);
  }

  /** Parse /etc/passwd for additional accounts */
  private _loadFromFS(): void {
    var passwd = fs.readFile('/etc/passwd');
    if (!passwd) return;
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
      };
      // Don't overwrite built-ins
      if (!this.byName.has(u.name)) this._addUser(u);
    }.bind(this));

    var group = fs.readFile('/etc/group');
    if (!group) return;
    group.split('\n').forEach(function(line) {
      if (!line || line[0] === '#') return;
      var f = line.split(':');
      if (f.length < 4) return;
      var gid = parseInt(f[2]);
      if (isNaN(gid)) return;
      if (!this.groups.has(gid)) {
        this._addGroup({ gid, name: f[0], members: f[3] ? f[3].split(',') : [] });
      }
    }.bind(this));
  }

  /** Write /etc/passwd and /etc/group */
  private _saveToFS(): void {
    var passwdLines: string[] = [];
    this.users.forEach(function(u) {
      passwdLines.push([u.name, u.passwordHash, u.uid, u.gid, u.displayName, u.home, u.shell].join(':'));
    });
    fs.writeFile('/etc/passwd', passwdLines.join('\n') + '\n');

    var shadowLines: string[] = [];
    this.users.forEach(function(u) {
      shadowLines.push([u.name, u.passwordHash, '0', '0', '99999', '7', '', '', ''].join(':'));
    });
    fs.writeFile('/etc/shadow', shadowLines.join('\n') + '\n');

    var groupLines: string[] = [];
    this.groups.forEach(function(g) {
      groupLines.push([g.name, 'x', g.gid, g.members.join(',')].join(':'));
    });
    fs.writeFile('/etc/group', groupLines.join('\n') + '\n');
  }

  // ── Public API ─────────────────────────────────────────────────────────────

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
    this.groups.forEach(function(g) {
      if (g.members.indexOf(name) !== -1) result.push(g);
    });
    return result;
  }

  listUsers(): User[] {
    return Array.from(this.users.values()).filter(function(u) { return u.uid < 65534; });
  }

  listGroups(): Group[] {
    return Array.from(this.groups.values());
  }

  /** Add a new user account */
  addUser(
    name:     string,
    password: string,
    opts:     Partial<Pick<User, 'displayName' | 'home' | 'shell' | 'uid' | 'gid'>> = {}
  ): User | null {
    if (this.byName.has(name)) return null;
    var uid = (opts.uid !== undefined) ? opts.uid : this.nextUid++;
    var gid = (opts.gid !== undefined) ? opts.gid : uid;
    var u: User = {
      uid, gid, name,
      displayName: opts.displayName || name,
      home:        opts.home        || '/home/' + name,
      shell:       opts.shell       || '/bin/repl',
      passwordHash: simpleHash(password),
    };
    this._addUser(u);
    if (!this.groups.has(gid)) {
      this._addGroup({ gid, name, members: [name] });
    }
    fs.mkdir(u.home);
    this._saveToFS();
    return u;
  }

  /** Remove a user (cannot remove root) */
  removeUser(name: string): boolean {
    var u = this.byName.get(name);
    if (!u || u.uid === 0) return false;
    this.users.delete(u.uid);
    this.byName.delete(name);
    this._saveToFS();
    return true;
  }

  /** Change a user's password */
  passwd(name: string, newPassword: string): boolean {
    var u = this.byName.get(name);
    if (!u) return false;
    (u as any).passwordHash = simpleHash(newPassword);
    this._saveToFS();
    return true;
  }

  /**
   * Authenticate: check credentials and, on success, switch current user.
   * An empty passwordHash means no password required.
   */
  login(name: string, password: string): boolean {
    var u = this.byName.get(name);
    if (!u) return false;
    if (u.passwordHash === '*') return false; // locked account
    if (u.passwordHash !== '' && u.passwordHash !== simpleHash(password)) return false;
    this.currentUid = u.uid;
    return true;
  }

  /** Switch user (su) — root can switch without password */
  su(nameOrUid: string | number): boolean {
    var u = this.getUser(nameOrUid);
    if (!u) return false;
    if (this.currentUid !== 0) return false; // only root can su freely for now
    this.currentUid = u.uid;
    return true;
  }

  logout(): void {
    this.currentUid = 1000; // back to default user
  }

  isRoot(): boolean { return this.currentUid === 0; }

  /** Format a user identity string like `id` command */
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
}

export const users = new UserManager();
