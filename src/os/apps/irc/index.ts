/**
 * JSOS IRC Client — Item 779
 * TypeScript IRC (RFC 1459 / RFC 2812) client.
 */

// ── IRC Message Parser ────────────────────────────────────────────────────────

export interface IRCMessage {
  prefix: string | null;     // nick!user@host or server
  command: string;           // PRIVMSG, NOTICE, JOIN, PART, PING, etc.
  params: string[];
  tags: Record<string, string>;  // IRCv3 message tags
  raw: string;
}

export function parseIRCMessage(raw: string): IRCMessage {
  let rest = raw.trim();
  const tags: Record<string, string> = {};
  // IRCv3 tags: @key=value;key2=value2 ...
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    const tagStr = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
    for (const pair of tagStr.split(';')) {
      const eq = pair.indexOf('=');
      if (eq >= 0) tags[pair.slice(0, eq)] = pair.slice(eq + 1);
      else tags[pair] = '';
    }
  }
  let prefix: string | null = null;
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  const parts = rest.split(' ');
  const command = parts[0].toUpperCase();
  const params: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].startsWith(':')) {
      params.push(parts.slice(i).join(' ').slice(1));
      break;
    }
    params.push(parts[i]);
  }
  return { prefix, command, params, tags, raw };
}

// ── IRCv3 CAP negotiation helpers ─────────────────────────────────────────────

export const SUPPORTED_CAPS = [
  'multi-prefix',
  'echo-message',
  'away-notify',
  'account-notify',
  'extended-join',
  'server-time',
  'message-tags',
] as const;

// ── IRC Channel / User State ──────────────────────────────────────────────────

export interface IRCUser {
  nick: string;
  user: string;
  host: string;
  modes: Set<string>;
  away: boolean;
  account?: string;
}

export interface IRCChannel {
  name: string;
  topic: string;
  modes: string;
  users: Map<string, IRCUser>;
  messages: IRCLine[];
  joined: boolean;
}

export interface IRCLine {
  timestamp: Date;
  nick: string;
  text: string;
  type: 'msg' | 'notice' | 'action' | 'join' | 'part' | 'quit' | 'mode' | 'topic' | 'server';
}

// ── IRC Client ────────────────────────────────────────────────────────────────

export interface IRCConfig {
  host: string;
  port: number;      // 6667 or 6697 (TLS)
  tls: boolean;
  nick: string;
  user: string;
  realName: string;
  password?: string;
  autoJoin?: string[];
}

export type IRCEventType = 'message' | 'join' | 'part' | 'quit' | 'nick' | 'topic' | 'mode' | 'notice' | 'raw' | 'connected' | 'disconnected';
export type IRCEventHandler = (data: unknown) => void;

export class IRCClient {
  private _config: IRCConfig;
  private _connected: boolean = false;
  private _registered: boolean = false;
  private _channels: Map<string, IRCChannel> = new Map();
  private _users: Map<string, IRCUser> = new Map();
  private _serverName: string = '';
  private _listeners: Map<IRCEventType, IRCEventHandler[]> = new Map();
  private _sendQueue: string[] = [];
  private _enabledCaps: Set<string> = new Set();

  constructor(config: IRCConfig) {
    this._config = config;
  }

  get nick(): string { return this._config.nick; }
  get connected(): boolean { return this._connected; }
  get registered(): boolean { return this._registered; }
  get serverName(): string { return this._serverName; }

  on(event: IRCEventType, fn: IRCEventHandler): void {
    let arr = this._listeners.get(event);
    if (!arr) { arr = []; this._listeners.set(event, arr); }
    arr.push(fn);
  }

  off(event: IRCEventType, fn: IRCEventHandler): void {
    const arr = this._listeners.get(event);
    if (!arr) return;
    const idx = arr.indexOf(fn);
    if (idx >= 0) arr.splice(idx, 1);
  }

  private _emit(event: IRCEventType, data: unknown): void {
    (this._listeners.get(event) ?? []).forEach(function(fn) { try { fn(data); } catch (_) {} });
  }

  /** Simulate connection and IRC registration handshake. */
  async connect(): Promise<void> {
    // Real impl: open TCP socket to config.host:port, optionally TLS-wrap it
    this._connected = true;
    this._emit('connected', null);
    if (this._config.password) this.raw(`PASS ${this._config.password}`);
    // IRCv3 CAP negotiation
    this.raw(`CAP LS 302`);
    this.raw(`NICK ${this._config.nick}`);
    this.raw(`USER ${this._config.user} 0 * :${this._config.realName}`);
  }

  /** Process an incoming raw IRC line (called by socket reader). */
  receive(rawLine: string): void {
    const msg = parseIRCMessage(rawLine);
    this._emit('raw', msg);
    this._dispatch(msg);
  }

  private _dispatch(msg: IRCMessage): void {
    switch (msg.command) {
      case 'PING':
        this.raw(`PONG :${msg.params[0] ?? ''}`);
        break;
      case '001': // RPL_WELCOME
        this._registered = true;
        this._serverName = msg.prefix ?? '';
        if (this._config.autoJoin?.length) {
          for (const ch of this._config.autoJoin) this.join(ch);
        }
        break;
      case 'CAP':
        this._handleCAP(msg);
        break;
      case 'JOIN':
        this._handleJoin(msg);
        break;
      case 'PART':
        this._handlePart(msg);
        break;
      case 'PRIVMSG':
        this._handlePrivmsg(msg);
        break;
      case 'NOTICE':
        this._handleNotice(msg);
        break;
      case 'NICK':
        this._handleNick(msg);
        break;
      case 'QUIT':
        this._handleQuit(msg);
        break;
      case '332': // RPL_TOPIC
        this._handleTopic(msg);
        break;
      case 'TOPIC':
        this._handleTopicChange(msg);
        break;
      case '353': // RPL_NAMREPLY
        this._handleNames(msg);
        break;
    }
  }

  private _handleCAP(msg: IRCMessage): void {
    const sub = msg.params[1];
    if (sub === 'LS') {
      const available = (msg.params[2] ?? '').split(' ').map(s => s.split('=')[0]);
      const request = SUPPORTED_CAPS.filter(c => available.includes(c));
      if (request.length) this.raw(`CAP REQ :${request.join(' ')}`);
      else this.raw('CAP END');
    } else if (sub === 'ACK') {
      (msg.params[2] ?? '').split(' ').forEach(c => this._enabledCaps.add(c));
      this.raw('CAP END');
    }
  }

  private _parsePrefix(prefix: string | null): IRCUser {
    if (!prefix) return { nick: '', user: '', host: '', modes: new Set(), away: false };
    const bang = prefix.indexOf('!');
    const at   = prefix.indexOf('@');
    const nick = bang >= 0 ? prefix.slice(0, bang) : prefix;
    const user = bang >= 0 && at >= 0 ? prefix.slice(bang + 1, at) : '';
    const host = at >= 0 ? prefix.slice(at + 1) : '';
    return { nick, user, host, modes: new Set(), away: false };
  }

  private _handleJoin(msg: IRCMessage): void {
    const channel = msg.params[0];
    const who = this._parsePrefix(msg.prefix);
    this._emit('join', { channel, user: who });
    if (who.nick === this._config.nick) {
      this._channels.set(channel, {
        name: channel, topic: '', modes: '', users: new Map(), messages: [], joined: true,
      });
    } else {
      const ch = this._channels.get(channel);
      if (ch) ch.users.set(who.nick, who);
    }
  }

  private _handlePart(msg: IRCMessage): void {
    const channel = msg.params[0];
    const who = this._parsePrefix(msg.prefix);
    this._emit('part', { channel, user: who, reason: msg.params[1] ?? '' });
    const ch = this._channels.get(channel);
    if (ch) {
      if (who.nick === this._config.nick) { ch.joined = false; }
      else ch.users.delete(who.nick);
    }
  }

  private _handlePrivmsg(msg: IRCMessage): void {
    const target = msg.params[0];
    const text   = msg.params[1] ?? '';
    const who    = this._parsePrefix(msg.prefix);
    const isAction = text.startsWith('\x01ACTION ') && text.endsWith('\x01');
    const line: IRCLine = {
      timestamp: new Date(),
      nick: who.nick,
      text: isAction ? text.slice(8, -1) : text,
      type: isAction ? 'action' : 'msg',
    };
    this._emit('message', { target, line, user: who });
    const ch = this._channels.get(target);
    if (ch) ch.messages.push(line);
  }

  private _handleNotice(msg: IRCMessage): void {
    const target = msg.params[0];
    const text   = msg.params[1] ?? '';
    const who    = this._parsePrefix(msg.prefix);
    const line: IRCLine = { timestamp: new Date(), nick: who.nick, text, type: 'notice' };
    this._emit('notice', { target, line, user: who });
    const ch = this._channels.get(target);
    if (ch) ch.messages.push(line);
  }

  private _handleNick(msg: IRCMessage): void {
    const who    = this._parsePrefix(msg.prefix);
    const newNick = msg.params[0];
    this._emit('nick', { oldNick: who.nick, newNick });
    if (who.nick === this._config.nick) this._config.nick = newNick;
    this._channels.forEach(function(ch) {
      const u = ch.users.get(who.nick);
      if (u) { ch.users.delete(who.nick); u.nick = newNick; ch.users.set(newNick, u); }
    });
  }

  private _handleQuit(msg: IRCMessage): void {
    const who    = this._parsePrefix(msg.prefix);
    const reason = msg.params[0] ?? '';
    this._emit('quit', { user: who, reason });
    this._channels.forEach(function(ch) { ch.users.delete(who.nick); });
  }

  private _handleTopic(msg: IRCMessage): void {
    const channel = msg.params[1];
    const topic   = msg.params[2] ?? '';
    const ch = this._channels.get(channel);
    if (ch) ch.topic = topic;
  }

  private _handleTopicChange(msg: IRCMessage): void {
    const channel = msg.params[0];
    const topic   = msg.params[1] ?? '';
    this._emit('topic', { channel, topic, user: this._parsePrefix(msg.prefix) });
    const ch = this._channels.get(channel);
    if (ch) ch.topic = topic;
  }

  private _handleNames(msg: IRCMessage): void {
    const channel = msg.params[2];
    const nicks   = (msg.params[3] ?? '').split(' ');
    const ch = this._channels.get(channel);
    if (!ch) return;
    const prefixChars = new Set(['@', '+', '%', '~', '&']);
    for (const raw of nicks) {
      let i = 0;
      const modes = new Set<string>();
      while (i < raw.length && prefixChars.has(raw[i])) { modes.add(raw[i]); i++; }
      const nick = raw.slice(i);
      ch.users.set(nick, { nick, user: '', host: '', modes, away: false });
    }
  }

  // ── Commands ────────────────────────────────────────────────────────────────

  raw(line: string): void {
    this._sendQueue.push(line); // real impl: write to socket
  }

  join(channel: string, key?: string): void {
    this.raw(key ? `JOIN ${channel} ${key}` : `JOIN ${channel}`);
  }

  part(channel: string, reason = 'Leaving'): void {
    this.raw(`PART ${channel} :${reason}`);
  }

  msg(target: string, text: string): void {
    this.raw(`PRIVMSG ${target} :${text}`);
    // Echo to local channel history
    const ch = this._channels.get(target);
    if (ch) ch.messages.push({ timestamp: new Date(), nick: this._config.nick, text, type: 'msg' });
  }

  action(target: string, text: string): void {
    this.msg(target, `\x01ACTION ${text}\x01`);
  }

  notice(target: string, text: string): void {
    this.raw(`NOTICE ${target} :${text}`);
  }

  nick(newNick: string): void { this.raw(`NICK ${newNick}`); }

  topic(channel: string, text?: string): void {
    this.raw(text !== undefined ? `TOPIC ${channel} :${text}` : `TOPIC ${channel}`);
  }

  kick(channel: string, nick: string, reason = ''): void {
    this.raw(reason ? `KICK ${channel} ${nick} :${reason}` : `KICK ${channel} ${nick}`);
  }

  mode(target: string, modeStr: string, ...args: string[]): void {
    this.raw(`MODE ${target} ${modeStr}${args.length ? ' ' + args.join(' ') : ''}`);
  }

  whois(nick: string): void { this.raw(`WHOIS ${nick}`); }
  list(channel?: string): void { this.raw(channel ? `LIST ${channel}` : 'LIST'); }

  quit(reason = 'goodbye'): void {
    this.raw(`QUIT :${reason}`);
    this._connected = false;
    this._emit('disconnected', null);
  }

  // ── State getters ────────────────────────────────────────────────────────────

  channel(name: string): IRCChannel | undefined { return this._channels.get(name); }
  channels(): IRCChannel[] {
    const arr: IRCChannel[] = [];
    this._channels.forEach(function(c) { arr.push(c); });
    return arr;
  }

  enabledCaps(): string[] { return Array.from(this._enabledCaps); }
  pendingSend(): string[] { return this._sendQueue.slice(); }
  flushSend(): string[] { const q = this._sendQueue; this._sendQueue = []; return q; }
}

export function createIRCClient(config: IRCConfig): IRCClient {
  return new IRCClient(config);
}
