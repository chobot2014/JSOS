/**
 * JSOS Email Client — Item 778
 * TypeScript IMAP reader + SMTP sender implementation.
 */

// ── IMAP Protocol Types ───────────────────────────────────────────────────────

export interface IMAPConfig {
  host: string;
  port: number;        // typically 993 (TLS) or 143
  tls: boolean;
  username: string;
  password: string;
}

export interface EmailHeader {
  uid: number;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  date: Date;
  messageId: string;
  flags: Set<string>;  // e.g. \Seen, \Answered, \Flagged
  size: number;
}

export interface EmailMessage extends EmailHeader {
  textBody: string;
  htmlBody: string;
  attachments: EmailAttachment[];
}

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  data: Uint8Array;
  size: number;
}

export type IMAPState = 'disconnected' | 'connected' | 'authenticated' | 'selected';

// ── IMAP Client ───────────────────────────────────────────────────────────────

export class IMAPClient {
  private _config: IMAPConfig;
  private _state: IMAPState = 'disconnected';
  private _mailbox: string = 'INBOX';
  private _tag: number = 1;
  private _uidValidity: number = 0;
  private _messageCount: number = 0;

  constructor(config: IMAPConfig) {
    this._config = config;
  }

  get state(): IMAPState { return this._state; }
  get mailbox(): string { return this._mailbox; }
  get messageCount(): number { return this._messageCount; }

  /** Simulate connection + login. Real impl would use sys.net.createSocket(). */
  async connect(): Promise<void> {
    // Placeholder: in real JSOS, open TLS socket to this._config.host:port
    this._state = 'connected';
    await this.login();
  }

  async login(): Promise<void> {
    if (this._state !== 'connected') throw new Error('Not connected');
    // LOGIN command: A001 LOGIN user pass
    this._nextTag();
    // Placeholder response parsing
    this._state = 'authenticated';
  }

  async select(mailbox: string): Promise<{ exists: number; uidValidity: number }> {
    if (this._state !== 'authenticated' && this._state !== 'selected') throw new Error('Not authenticated');
    this._mailbox = mailbox;
    this._state = 'selected';
    // Placeholder: parse EXISTS and UIDVALIDITY from * n EXISTS / * OK [UIDVALIDITY n]
    return { exists: this._messageCount, uidValidity: this._uidValidity };
  }

  async list(pattern = '*'): Promise<string[]> {
    // LIST "" pattern → returns mailbox names
    this._nextTag();
    return ['INBOX', 'Sent', 'Drafts', 'Trash', 'Spam'];
  }

  async fetchHeaders(seqRange: string): Promise<EmailHeader[]> {
    // FETCH seqRange (UID FLAGS ENVELOPE RFC822.SIZE)
    if (this._state !== 'selected') throw new Error('No mailbox selected');
    this._nextTag();
    return []; // placeholder — real impl parses IMAP FETCH responses
  }

  async fetchMessage(uid: number): Promise<EmailMessage | null> {
    if (this._state !== 'selected') throw new Error('No mailbox selected');
    this._nextTag();
    return null; // placeholder
  }

  async search(criteria: string): Promise<number[]> {
    // UID SEARCH criteria (e.g. "UNSEEN", "SUBJECT foo", "SINCE 01-Jan-2024")
    this._nextTag();
    return [];
  }

  async addFlags(uid: number, flags: string[]): Promise<void> {
    this._nextTag();
    // UID STORE uid +FLAGS (flags...)
  }

  async removeFlags(uid: number, flags: string[]): Promise<void> {
    this._nextTag();
    // UID STORE uid -FLAGS (flags...)
  }

  async expunge(): Promise<void> {
    this._nextTag();
    // EXPUNGE — permanently remove \Deleted messages
  }

  async copy(uid: number, destMailbox: string): Promise<void> {
    this._nextTag();
    // UID COPY uid destMailbox
  }

  async createMailbox(name: string): Promise<void> {
    this._nextTag();
    // CREATE name
  }

  async deleteMailbox(name: string): Promise<void> {
    this._nextTag();
    // DELETE name
  }

  async logout(): Promise<void> {
    this._nextTag();
    this._state = 'disconnected';
  }

  private _nextTag(): string {
    return 'A' + String(this._tag++).padStart(4, '0');
  }
}

// ── SMTP Client ───────────────────────────────────────────────────────────────

export interface SMTPConfig {
  host: string;
  port: number;      // 465 (SMTPS) or 587 (STARTTLS) or 25
  tls: boolean;
  username: string;
  password: string;
}

export interface SendMailOptions {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  textBody?: string;
  htmlBody?: string;
  attachments?: EmailAttachment[];
}

export class SMTPClient {
  private _config: SMTPConfig;
  private _connected: boolean = false;
  private _authenticated: boolean = false;

  constructor(config: SMTPConfig) {
    this._config = config;
  }

  async connect(): Promise<void> {
    // Placeholder: real impl opens socket to this._config.host:port
    this._connected = true;
    // Read 220 greeting, send EHLO, negotiate STARTTLS/AUTH
    await this._authenticate();
  }

  private async _authenticate(): Promise<void> {
    // AUTH PLAIN or AUTH LOGIN
    this._authenticated = true;
  }

  async send(opts: SendMailOptions): Promise<string> {
    if (!this._connected || !this._authenticated) throw new Error('SMTP not ready');
    // Build RFC 2822 message
    const msgId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@jsos.local>`;
    const _msg = this._buildMIME(opts, msgId);
    // MAIL FROM: <from>  →  RCPT TO: <to>  →  DATA  →  . → QUIT
    return msgId;
  }

  private _buildMIME(opts: SendMailOptions, msgId: string): string {
    const headers = [
      `Message-ID: ${msgId}`,
      `Date: ${new Date().toUTCString()}`,
      `From: ${opts.from}`,
      `To: ${opts.to.join(', ')}`,
      opts.cc?.length ? `Cc: ${opts.cc.join(', ')}` : '',
      `Subject: ${opts.subject}`,
      'MIME-Version: 1.0',
    ].filter(Boolean);

    if (opts.attachments?.length) {
      const boundary = 'jsos_' + Math.random().toString(36).slice(2);
      headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
      let body = headers.join('\r\n') + '\r\n\r\n';
      if (opts.textBody) {
        body += `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${opts.textBody}\r\n`;
      }
      if (opts.htmlBody) {
        body += `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${opts.htmlBody}\r\n`;
      }
      for (const att of opts.attachments) {
        body += `--${boundary}\r\nContent-Type: ${att.mimeType}\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${att.filename}"\r\n\r\n`;
        body += _base64Encode(att.data) + '\r\n';
      }
      body += `--${boundary}--\r\n`;
      return body;
    }
    headers.push('Content-Type: text/plain; charset=utf-8');
    return headers.join('\r\n') + '\r\n\r\n' + (opts.textBody ?? '');
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    this._authenticated = false;
  }
}

function _base64Encode(data: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  for (let i = 0; i < data.length; i += 3) {
    const b0 = data[i]; const b1 = data[i + 1] ?? 0; const b2 = data[i + 2] ?? 0;
    result += chars[b0 >> 2] + chars[((b0 & 3) << 4) | (b1 >> 4)] +
              (i + 1 < data.length ? chars[((b1 & 0xf) << 2) | (b2 >> 6)] : '=') +
              (i + 2 < data.length ? chars[b2 & 0x3f] : '=');
  }
  return result;
}

// ── Email App ─────────────────────────────────────────────────────────────────

export interface EmailAccount {
  id: string;
  name: string;
  address: string;
  imap: IMAPConfig;
  smtp: SMTPConfig;
}

export class EmailApp {
  private _accounts: Map<string, EmailAccount> = new Map();
  private _clients: Map<string, { imap: IMAPClient; smtp: SMTPClient }> = new Map();
  private _drafts: SendMailOptions[] = [];

  addAccount(account: EmailAccount): void {
    this._accounts.set(account.id, account);
    this._clients.set(account.id, {
      imap: new IMAPClient(account.imap),
      smtp: new SMTPClient(account.smtp),
    });
  }

  removeAccount(id: string): void {
    this._accounts.delete(id);
    this._clients.delete(id);
  }

  async connect(accountId: string): Promise<void> {
    const c = this._clients.get(accountId);
    if (!c) throw new Error(`Unknown account ${accountId}`);
    await c.imap.connect();
    await c.smtp.connect();
  }

  imap(accountId: string): IMAPClient {
    const c = this._clients.get(accountId);
    if (!c) throw new Error(`Unknown account ${accountId}`);
    return c.imap;
  }

  smtp(accountId: string): SMTPClient {
    const c = this._clients.get(accountId);
    if (!c) throw new Error(`Unknown account ${accountId}`);
    return c.smtp;
  }

  saveDraft(draft: SendMailOptions): number {
    this._drafts.push(draft);
    return this._drafts.length - 1;
  }

  getDraft(idx: number): SendMailOptions | undefined { return this._drafts[idx]; }
  listDrafts(): SendMailOptions[] { return this._drafts.slice(); }

  accounts(): EmailAccount[] {
    const arr: EmailAccount[] = [];
    this._accounts.forEach(function(a) { arr.push(a); });
    return arr;
  }
}

export const emailApp = new EmailApp();
