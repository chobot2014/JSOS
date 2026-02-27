/**
 * JSOS TOTP — Time-based One-Time Password (RFC 6238 / HOTP RFC 4226)
 *
 * [Item 756b] TypeScript TOTP 2FA implementation.
 *
 * Self-contained — no external dependencies beyond the kernel uptime clock and
 * the SHA-1 HMAC needed by HOTP.  Works in QuickJS without Node crypto.
 *
 * Usage:
 *   const secret = TOTP.generateSecret();          // base32 secret
 *   const token  = TOTP.generate(secret);          // 6-digit OTP
 *   const ok     = TOTP.verify(secret, userInput); // validate with ±1 window
 *   const uri    = TOTP.otpAuthURI(secret, 'alice', 'JSOS');
 */

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── Base32 ────────────────────────────────────────────────────────────────────
const B32_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function b32Encode(bytes: number[]): string {
  var out = '';
  var i = 0;
  while (i < bytes.length) {
    var b0 = bytes[i]     ?? 0;
    var b1 = bytes[i + 1] ?? 0;
    var b2 = bytes[i + 2] ?? 0;
    var b3 = bytes[i + 3] ?? 0;
    var b4 = bytes[i + 4] ?? 0;
    var n  = (b0 << 32) + (b1 << 24) + (b2 << 16) + (b3 << 8) + b4;
    // Extract 5-bit groups
    out += B32_ALPHA[(n >>> 35) & 0x1f];
    out += B32_ALPHA[(n >>> 30) & 0x1f];
    out += B32_ALPHA[(n >>> 25) & 0x1f];
    out += B32_ALPHA[(n >>> 20) & 0x1f];
    out += B32_ALPHA[(n >>> 15) & 0x1f];
    out += B32_ALPHA[(n >>> 10) & 0x1f];
    out += B32_ALPHA[(n >>>  5) & 0x1f];
    out += B32_ALPHA[ n         & 0x1f];
    i += 5;
  }
  // Pad to multiple of 8
  while (out.length % 8 !== 0) out += '=';
  return out;
}

function b32Decode(s: string): number[] {
  s = s.toUpperCase().replace(/=+$/, '');
  var bytes: number[] = [];
  var buf = 0, bits = 0;
  for (var i = 0; i < s.length; i++) {
    var v = B32_ALPHA.indexOf(s[i]);
    if (v < 0) continue;
    buf = (buf << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buf >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return bytes;
}

// ── SHA-1 ─────────────────────────────────────────────────────────────────────
function sha1Block(data: number[]): number[] {
  // Pad
  var len = data.length;
  var bits = len * 8;
  data.push(0x80);
  while ((data.length % 64) !== 56) data.push(0);
  // Append bit length as 64-bit big-endian
  for (var i = 7; i >= 0; i--) data.push((bits / Math.pow(2, i * 8)) & 0xff);

  var h = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
  function rot(x: number, n: number): number { return ((x << n) | (x >>> (32 - n))) >>> 0; }
  function add(...args: number[]): number { return args.reduce(function(a, b) { return (a + b) >>> 0; }, 0); }

  for (var chunk = 0; chunk < data.length; chunk += 64) {
    var w: number[] = [];
    for (var j = 0; j < 16; j++)
      w[j] = ((data[chunk+j*4]<<24)|(data[chunk+j*4+1]<<16)|(data[chunk+j*4+2]<<8)|data[chunk+j*4+3])>>>0;
    for (var j2 = 16; j2 < 80; j2++)
      w[j2] = rot(w[j2-3] ^ w[j2-8] ^ w[j2-14] ^ w[j2-16], 1);

    var [ha, hb, hc, hd, he] = h;
    for (var step = 0; step < 80; step++) {
      var f: number, k: number;
      if (step < 20)      { f = (hb & hc) | ((~hb) & hd); k = 0x5A827999; }
      else if (step < 40) { f = hb ^ hc ^ hd;              k = 0x6ED9EBA1; }
      else if (step < 60) { f = (hb & hc) | (hb & hd) | (hc & hd); k = 0x8F1BBCDC; }
      else                { f = hb ^ hc ^ hd;              k = 0xCA62C1D6; }
      var tmp = add(rot(ha, 5), f, he, w[step], k);
      he = hd; hd = hc; hc = rot(hb, 30); hb = ha; ha = tmp;
    }
    h = [add(h[0],ha)>>>0, add(h[1],hb)>>>0, add(h[2],hc)>>>0, add(h[3],hd)>>>0, add(h[4],he)>>>0];
  }

  var out: number[] = [];
  h.forEach(function(v) {
    out.push((v>>>24)&0xff, (v>>>16)&0xff, (v>>>8)&0xff, v&0xff);
  });
  return out;
}

function hmacSHA1(key: number[], msg: number[]): number[] {
  if (key.length > 64) key = sha1Block(key.slice());
  while (key.length < 64) key.push(0);
  var ipad = key.map(function(b) { return b ^ 0x36; });
  var opad = key.map(function(b) { return b ^ 0x5c; });
  var inner = sha1Block([...ipad, ...msg]);
  return sha1Block([...opad, ...inner]);
}

// ── HOTP ─────────────────────────────────────────────────────────────────────
function hotp(secret: number[], counter: number, digits: number = 6): string {
  // Encode counter as 8-byte big-endian
  var msg: number[] = [0, 0, 0, 0,
    (counter >>> 24) & 0xff,
    (counter >>> 16) & 0xff,
    (counter >>>  8) & 0xff,
    counter & 0xff,
  ];
  var hmac = hmacSHA1(secret, msg);
  var offset = hmac[19] & 0x0f;
  var code = ((hmac[offset] & 0x7f) << 24) |
             ((hmac[offset + 1] & 0xff) << 16) |
             ((hmac[offset + 2] & 0xff) << 8) |
              (hmac[offset + 3] & 0xff);
  var otp = (code % Math.pow(10, digits)).toString();
  while (otp.length < digits) otp = '0' + otp;
  return otp;
}

// ── TOTP ─────────────────────────────────────────────────────────────────────

export interface TOTPConfig {
  /** Base32-encoded secret key. */
  secret: string;
  /** Digits in the OTP (default 6). */
  digits?: number;
  /** Step size in seconds (default 30). */
  period?: number;
  /** Number of time steps to check before/after current (default 1). */
  window?: number;
}

export interface TOTPResult {
  valid: boolean;
  /** The counter (time step) that matched, or -1 if no match. */
  matchedStep: number;
}

export class TOTP {
  /**
   * [Item 756b] Generate a random 20-byte base32 TOTP secret.
   * Use this as the seed when provisioning a user's 2FA.
   */
  static generateSecret(bytes: number = 20): string {
    var entropy: number[] = [];
    // Mix kernel ticks, uptime entropy, and Math.random for seeding
    var seed = kernel.getTicks();
    for (var i = 0; i < bytes; i++) {
      seed = (seed * 1664525 + 1013904223) ^ (Math.random() * 0xffffffff | 0);
      entropy.push((seed >>> (i % 4) * 8) & 0xff);
    }
    return b32Encode(entropy).replace(/=+$/, '');
  }

  /**
   * [Item 756b] Generate an OTP for the current time.
   * `cfg` can be a bare secret string or a full TOTPConfig.
   */
  static generate(cfg: string | TOTPConfig): string {
    var c: TOTPConfig = typeof cfg === 'string' ? { secret: cfg } : cfg;
    var period = c.period ?? 30;
    // Use kernel uptime as wall-clock surrogate (seconds since boot ≈ 0)
    // In a real system with wallclock this would be: Math.floor(Date.now()/1000/period)
    var uptime = kernel.getUptime();
    var step   = Math.floor(uptime / period);
    return hotp(b32Decode(c.secret), step, c.digits ?? 6);
  }

  /**
   * [Item 756b] Verify a user-provided token against a secret.
   * Accepts tokens from the current ±`window` time steps.
   */
  static verify(cfg: string | TOTPConfig, token: string): TOTPResult {
    var c: TOTPConfig = typeof cfg === 'string' ? { secret: cfg } : cfg;
    var period = c.period ?? 30;
    var w      = c.window ?? 1;
    var digits = c.digits ?? 6;
    var key    = b32Decode(c.secret);
    var uptime = kernel.getUptime();
    var step   = Math.floor(uptime / period);
    for (var delta = -w; delta <= w; delta++) {
      if (hotp(key, step + delta, digits) === token.trim()) {
        return { valid: true, matchedStep: step + delta };
      }
    }
    return { valid: false, matchedStep: -1 };
  }

  /**
   * [Item 756b] Generate an otpauth:// URI for QR-code provisioning.
   * See https://github.com/google/google-authenticator/wiki/Key-Uri-Format
   */
  static otpAuthURI(cfg: string | TOTPConfig, accountName: string, issuer: string = 'JSOS'): string {
    var c: TOTPConfig = typeof cfg === 'string' ? { secret: cfg } : cfg;
    var enc = encodeURIComponent;
    var period = c.period ?? 30;
    var digits = c.digits ?? 6;
    return 'otpauth://totp/' + enc(issuer) + ':' + enc(accountName)
      + '?secret=' + c.secret
      + '&issuer=' + enc(issuer)
      + '&algorithm=SHA1'
      + '&digits=' + digits
      + '&period=' + period;
  }

  /**
   * Low-level: generate HOTP for an explicit counter value.
   */
  static hotp(secret: string, counter: number, digits: number = 6): string {
    return hotp(b32Decode(secret), counter, digits);
  }
}

// ── TOTP User Store ───────────────────────────────────────────────────────────

export interface TOTPEnrollment {
  uid: number;
  username: string;
  secret: string;
  enrolledAt: number;   /** kernel.getUptime() at enrollment */
  label: string;
}

/**
 * [Item 756b] Per-user TOTP enrollment store.
 * Stores enrollments in /etc/totp (JSON, one entry per line).
 */
export class TOTPStore {
  private readonly _path = '/etc/totp';
  private _store: Map<number, TOTPEnrollment> = new Map();

  constructor() { this._load(); }

  private _load(): void {
    try {
      var content = (kernel as any).fs ? (kernel as any).fs.readFile(this._path) : null;
      if (!content) return;
      content.split('\n').filter(Boolean).forEach((line: string) => {
        try {
          var e: TOTPEnrollment = JSON.parse(line);
          this._store.set(e.uid, e);
        } catch (_) {}
      });
    } catch (_) {}
  }

  private _save(): void {
    try {
      var lines: string[] = [];
      this._store.forEach(function(e) { lines.push(JSON.stringify(e)); });
      if ((kernel as any).fs) (kernel as any).fs.writeFile(this._path, lines.join('\n') + '\n');
    } catch (_) {}
  }

  enroll(uid: number, username: string, label: string = 'JSOS'): TOTPEnrollment {
    var secret = TOTP.generateSecret();
    var e: TOTPEnrollment = { uid, username, secret, enrolledAt: kernel.getUptime(), label };
    this._store.set(uid, e);
    this._save();
    return e;
  }

  remove(uid: number): boolean {
    if (!this._store.has(uid)) return false;
    this._store.delete(uid);
    this._save();
    return true;
  }

  isEnrolled(uid: number): boolean { return this._store.has(uid); }

  verify(uid: number, token: string): boolean {
    var e = this._store.get(uid);
    if (!e) return false;
    return TOTP.verify(e.secret, token).valid;
  }

  get(uid: number): TOTPEnrollment | undefined { return this._store.get(uid); }

  list(): TOTPEnrollment[] {
    var arr: TOTPEnrollment[] = [];
    this._store.forEach(function(e) { arr.push(e); });
    return arr;
  }
}

export const totpStore = new TOTPStore();
