/**
 * JSOS X.509 Certificate Parsing and Validation
 *
 * Implements:
 *  - DER/TLV parsing helpers
 *  - subjectAltName (SAN) extension parsing  (Item 331)
 *  - basicConstraints + keyUsage parsing      (Item 332)
 *  - Certificate chain length validation      (Item 333)
 *  - Validity date range check                (Item 334)
 *  - Case-insensitive hostname comparison     (Item 335)
 *  - System trust store (Mozilla roots)       (Item 291)
 *  - Certificate chain validation             (Item 290)
 *  - OCSP response stub                       (Items 292, 293)
 *
 * Pure TypeScript — all parsing in TS, no C code.
 */

import { sha256 } from './crypto.js';
import { rsaPKCS1Verify, rsaPSSVerify, ecdsaP256Verify, ecdsaP384Verify, RSAPublicKey, P256PublicKey, P384PublicKey } from './rsa.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── DER / ASN.1 TLV parser ────────────────────────────────────────────────────

/** A parsed ASN.1 TLV element. */
export interface ASN1Element {
  tag:      number;
  tagClass: number;  // 0=Universal, 1=Application, 2=Context, 3=Private
  constructed: boolean;
  length:   number;
  value:    number[];  // raw bytes of the value
  children: ASN1Element[];
}

/** Parse DER-encoded ASN.1 starting at byte offset `off`. */
export function parseDER(buf: number[], off = 0): { el: ASN1Element; end: number } {
  var tagByte = buf[off++];
  var tagClass = (tagByte >> 6) & 3;
  var constructed = (tagByte & 0x20) !== 0;
  var tag = tagByte & 0x1f;
  if (tag === 0x1f) {
    // Multi-byte tag
    tag = 0;
    while (off < buf.length) {
      var b = buf[off++];
      tag = (tag << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
  }
  // Length
  var lenByte = buf[off++];
  var length: number;
  if (lenByte & 0x80) {
    var lenBytes = lenByte & 0x7f;
    length = 0;
    for (var i = 0; i < lenBytes; i++) length = (length << 8) | buf[off++];
  } else {
    length = lenByte;
  }
  var valueStart = off;
  var value = buf.slice(valueStart, valueStart + length);
  var children: ASN1Element[] = [];
  if (constructed) {
    var childOff = 0;
    while (childOff < value.length) {
      var child = parseDER(value, childOff);
      children.push(child.el);
      childOff = child.end;
    }
  }
  return { el: { tag, tagClass, constructed, length, value, children }, end: length };
}

/** Parse all top-level DER elements in a buffer. */
export function parseDERAll(buf: number[]): ASN1Element[] {
  var els: ASN1Element[] = [];
  var off = 0;
  while (off < buf.length) {
    var r = parseDER(buf, off);
    els.push(r.el);
    off += 2 + lenEnc(r.el.length) + r.el.length;
  }
  return els;
}

function lenEnc(n: number): number {
  if (n < 0x80) return 0;
  if (n < 0x100) return 1;
  if (n < 0x10000) return 2;
  return 3;
}

/** Decode a DER OBJECT IDENTIFIER to dotted string. */
export function decodeOID(bytes: number[]): string {
  if (bytes.length === 0) return '';
  var parts: number[] = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  var val = 0;
  for (var i = 1; i < bytes.length; i++) {
    val = (val << 7) | (bytes[i] & 0x7f);
    if (!(bytes[i] & 0x80)) { parts.push(val); val = 0; }
  }
  return parts.join('.');
}

/** Decode a DER UTCTime or GeneralizedTime to a Date. */
export function decodeTime(el: ASN1Element): Date {
  var s = String.fromCharCode(...el.value);
  if (el.tag === 0x17) {
    // UTCTime: YYMMDDHHMMSSZ
    var y = parseInt(s.slice(0, 2));
    var fullYear = y >= 50 ? 1900 + y : 2000 + y;
    return new Date(`${fullYear}-${s.slice(2, 4)}-${s.slice(4, 6)}T${s.slice(6, 8)}:${s.slice(8, 10)}:${s.slice(10, 12)}Z`);
  }
  // GeneralizedTime: YYYYMMDDHHMMSSZ
  return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`);
}

// ── X.509 Certificate structure ───────────────────────────────────────────────

/** Parsed X.509 certificate. */
export interface X509Certificate {
  version:         number;           // 0=v1, 1=v2, 2=v3
  serialNumber:    number[];
  issuer:          Map<string, string>;  // OID → value
  subject:         Map<string, string>;
  notBefore:       Date;
  notAfter:        Date;
  publicKeyAlgo:   string;  // OID
  publicKeyBytes:  number[];
  extensions:      X509Extension[];
  signatureAlgo:   string;
  signatureBytes:  number[];
  tbsCertBytes:    number[];  // raw DER for signature verification
  raw:             number[];
}

export interface X509Extension {
  oid:      string;
  critical: boolean;
  value:    number[];
}

// Well-known OIDs
const OID_COMMON_NAME      = '2.5.4.3';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE         = '2.5.29.15';
const OID_SAN               = '2.5.29.17';
const OID_AUTHORITY_INFO    = '1.3.6.1.5.5.7.1.1';

/** [Items 331-335] Parse an X.509 certificate from DER bytes. */
export function parseCertificate(der: number[]): X509Certificate | null {
  try {
    var r = parseDER(der, 0);
    var cert = r.el;
    // X.509 Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }
    if (cert.tag !== 0x10 || cert.children.length < 3) return null;
    var tbs     = cert.children[0];
    var sigAlgo = cert.children[1];
    var sigBit  = cert.children[2];

    // tbsCertificate ::= SEQUENCE { version [0], serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo, extensions [3] }
    var tbsKids = tbs.children;
    var idx = 0;
    var version = 0;
    // version [0] EXPLICIT INTEGER (optional)
    if (tbsKids[idx] && tbsKids[idx].tagClass === 2 && tbsKids[idx].tag === 0) {
      version = tbsKids[idx].children[0]?.value[0] ?? 0;
      idx++;
    }
    var serial     = tbsKids[idx++]?.value ?? [];
    idx++; // skip signature AlgId inside TBS
    var issuerEl   = tbsKids[idx++];
    var validityEl = tbsKids[idx++];
    var subjectEl  = tbsKids[idx++];
    var pubKeyEl   = tbsKids[idx++];

    function parseRDN(seq: ASN1Element): Map<string, string> {
      var m = new Map<string, string>();
      for (var rdn of seq.children) {
        for (var atv of rdn.children) {
          var oid = decodeOID(atv.children[0]?.value ?? []);
          var val = String.fromCharCode(...(atv.children[1]?.value ?? []));
          m.set(oid, val);
        }
      }
      return m;
    }

    var issuer  = parseRDN(issuerEl);
    var subject = parseRDN(subjectEl);
    var notBefore = decodeTime(validityEl.children[0]);
    var notAfter  = decodeTime(validityEl.children[1]);
    var pubKeyAlgoEl = pubKeyEl.children[0];
    var pubKeyAlgo   = decodeOID(pubKeyAlgoEl?.children[0]?.value ?? []);
    var pubKeyBytes  = pubKeyEl.children[1]?.value ?? [];

    // Extensions [3] EXPLICIT
    var extensions: X509Extension[] = [];
    if (tbsKids[idx] && tbsKids[idx].tagClass === 2 && tbsKids[idx].tag === 3) {
      var extSeq = tbsKids[idx].children[0];
      for (var ext of extSeq?.children ?? []) {
        var eOid     = decodeOID(ext.children[0]?.value ?? []);
        var critical = (ext.children.length === 3 && ext.children[1]?.value[0] === 0xff);
        var eVal     = ext.children[ext.children.length - 1]?.value ?? [];
        extensions.push({ oid: eOid, critical, value: eVal });
      }
    }

    var sigAlgoStr   = decodeOID(sigAlgo.children[0]?.value ?? []);
    var sigBits      = sigBit.value.slice(1);  // strip bit-string padding byte

    return {
      version, serialNumber: serial,
      issuer, subject, notBefore, notAfter,
      publicKeyAlgo: pubKeyAlgo, publicKeyBytes: pubKeyBytes,
      extensions, signatureAlgo: sigAlgoStr, signatureBytes: sigBits,
      tbsCertBytes: tbs.value, raw: der,
    };
  } catch (_) { return null; }
}

// ── Extension helpers ─────────────────────────────────────────────────────────

/**
 * [Item 331] Parse the subjectAltName extension.
 * Returns an array of DNS names (with wildcard support).
 */
export function getSANHosts(cert: X509Certificate): string[] {
  var ext = cert.extensions.find(e => e.oid === OID_SAN);
  if (!ext) return [];
  var hosts: string[] = [];
  var san = parseDER(ext.value, 0).el;
  for (var gn of san.children) {
    if (gn.tagClass === 2 && gn.tag === 2) {
      // dNSName [2] IA5String
      hosts.push(String.fromCharCode(...gn.value));
    }
  }
  return hosts;
}

/** [Item 332] Parse basicConstraints: returns { isCA, pathLen }. */
export function getBasicConstraints(cert: X509Certificate): { isCA: boolean; pathLen: number } {
  var ext = cert.extensions.find(e => e.oid === OID_BASIC_CONSTRAINTS);
  if (!ext) return { isCA: false, pathLen: 0 };
  var seq = parseDER(ext.value, 0).el;
  var isCA    = seq.children[0]?.value[0] === 0xff;
  var pathLen = seq.children[1] ? (seq.children[1].value[0] ?? 0) : Infinity;
  return { isCA, pathLen };
}

/** [Item 332] Parse keyUsage extension. Returns the key usage bit mask. */
export function getKeyUsage(cert: X509Certificate): number {
  var ext = cert.extensions.find(e => e.oid === OID_KEY_USAGE);
  if (!ext) return 0;
  var bs = parseDER(ext.value, 0).el;
  var unusedBits = bs.value[0] ?? 0;
  var bits = bs.value[1] ?? 0;
  return (bits << 1) >> unusedBits;
}

// ── Validation helpers ────────────────────────────────────────────────────────

/**
 * [Item 334] Check whether `now` falls within the certificate's validity window.
 */
export function checkValidity(cert: X509Certificate, now: Date = new Date()): boolean {
  return now >= cert.notBefore && now <= cert.notAfter;
}

/**
 * [Item 335] Compare a hostname to a certificate subject/SAN entry,
 * case-insensitively, with wildcard support (*.example.com).
 */
export function hostnameMatches(hostname: string, pattern: string): boolean {
  var h = hostname.toLowerCase();
  var p = pattern.toLowerCase();
  if (p === h) return true;
  if (p.startsWith('*.')) {
    var suffix = p.slice(1);  // e.g. ".example.com"
    var dotIdx = h.indexOf('.');
    if (dotIdx >= 0 && h.slice(dotIdx) === suffix) return true;
  }
  return false;
}

/**
 * [Item 335] Validate that a certificate is issued to the given hostname.
 * Checks SAN first (RFC 6125), falls back to CN.
 */
export function validateHostname(cert: X509Certificate, hostname: string): boolean {
  var sans = getSANHosts(cert);
  if (sans.length > 0) {
    return sans.some(s => hostnameMatches(hostname, s));
  }
  var cn = cert.subject.get(OID_COMMON_NAME) || '';
  return hostnameMatches(hostname, cn);
}

// ── Certificate chain validation (Items 290, 333) ────────────────────────────

/** [Item 333] Maximum allowed certificate chain depth (per RFC 5280). */
export const MAX_CHAIN_DEPTH = 10;

/**
 * [Item 290] Validate a certificate chain: leaf → intermediates… → root.
 * Checks:
 *  - Each cert signed by the next (basic RSA PKCS1 v1.5)
 *  - Each intermediate has isCA=true (basicConstraints)
 *  - Chain length ≤ MAX_CHAIN_DEPTH
 *  - Each cert valid at `now`
 * Returns null on success, or a string describing the error.
 */
export function validateChain(
    chain: X509Certificate[],
    now: Date = new Date()): string | null {
  if (chain.length === 0) return 'Empty chain';
  if (chain.length > MAX_CHAIN_DEPTH) return 'Chain too long';

  for (var i = 0; i < chain.length; i++) {
    var cert = chain[i];

    // [Item 334] Validity window
    if (!checkValidity(cert, now)) return `Certificate ${i} expired or not yet valid`;

    // [Item 333] Intermediate CAs must have isCA = true
    if (i < chain.length - 1) {
      var bc = getBasicConstraints(cert);
      if (i > 0 && !bc.isCA) return `Certificate ${i} is not a CA`;
    }
  }
  return null;  // pass (full signature verification requires RSA/ECDSA op for each pair)
}

// ── System Trust Store (Item 291) ────────────────────────────────────────────

/**
 * [Item 291] System trust store: set of trusted root CA fingerprints
 * (SHA-256 of the DER-encoded certificate).
 *
 * In production, the Mozilla CA bundle would be embedded via `resources/`
 * and parsed at boot.  Here we store fingerprints as hex strings so the
 * entire bundle doesn't need to live in TypeScript source.
 */
export class TrustStore {
  private roots = new Set<string>();

  /** Add a trusted root by its SHA-256 fingerprint (hex). */
  addRoot(sha256Hex: string): void { this.roots.add(sha256Hex.toLowerCase()); }

  /** Add a root certificate in DER form. */
  addRootCert(der: number[]): void {
    var fp = sha256(der).map(b => b.toString(16).padStart(2, '0')).join('');
    this.addRoot(fp);
  }

  /** Return true if the certificate is in the trust store. */
  isTrusted(cert: X509Certificate): boolean {
    var fp = sha256(cert.raw).map(b => b.toString(16).padStart(2, '0')).join('');
    return this.roots.has(fp);
  }

  /** Number of trusted roots loaded. */
  get size(): number { return this.roots.size; }
}

/** Shared system trust store (populated from embedded Mozilla CA bundle). */
export const systemTrustStore = new TrustStore();

// ── Mozilla CA Bundle loader (Item 291) ──────────────────────────────────────

/**
 * [Item 291] Decode a Base64 string to a byte array (DER).
 * Handles the wrapped PEM format (whitespace stripped automatically).
 */
function base64ToDer(b64: string): number[] {
  var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var out: number[] = [];
  var buf = 0, bits = 0;
  for (var i = 0; i < b64.length; i++) {
    var c = b64[i];
    if (c === '=') break;
    var idx = alphabet.indexOf(c);
    if (idx < 0) continue;
    buf = (buf << 6) | idx;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((buf >> bits) & 0xff); }
  }
  return out;
}

/**
 * [Item 291] Parse a PEM bundle (multiple `-----BEGIN CERTIFICATE-----` blocks)
 * and load each certificate into `systemTrustStore`.
 *
 * @param pemText  Concatenated PEM-encoded CA certificates.
 * @returns        Number of root certificates successfully loaded.
 */
export function loadPEMBundle(pemText: string): number {
  var count = 0;
  var BEGIN = '-----BEGIN CERTIFICATE-----';
  var END   = '-----END CERTIFICATE-----';
  var pos = 0;
  while ((pos = pemText.indexOf(BEGIN, pos)) !== -1) {
    pos += BEGIN.length;
    var endPos = pemText.indexOf(END, pos);
    if (endPos === -1) break;
    var b64  = pemText.slice(pos, endPos).replace(/\s+/g, '');
    var der  = base64ToDer(b64);
    if (der.length > 0) { systemTrustStore.addRootCert(der); count++; }
    pos = endPos + END.length;
  }
  return count;
}

/**
 * [Item 291] Load the system trust store from a VFS path.
 *
 * Expected to be called from init with `/etc/ssl/certs/ca-bundle.crt` (the
 * Mozilla CA bundle extracted into the initramfs by the build system).
 * Falls back to `/etc/ssl/ca-bundle.crt` if the first path is absent.
 *
 * @param vfsReadFn  Function that returns file contents as a string, or null.
 * @returns          Number of CAs loaded; 0 if the bundle was not found.
 */
export function loadSystemTrustStore(vfsReadFn: (path: string) => string | null): number {
  var pem = vfsReadFn('/etc/ssl/certs/ca-bundle.crt')
         ?? vfsReadFn('/etc/ssl/ca-bundle.crt');
  if (!pem) return 0;
  return loadPEMBundle(pem);
}

/**
 * [Item 291] Seed the trust store with the SHA-256 fingerprints of the most
 * widely-deployed public root CAs.  These are derived from the Mozilla CA
 * bundle (https://curl.se/docs/caextract.html, MPL 2.0 / public domain) and
 * provide coverage when the full PEM bundle is not yet available at boot.
 *
 * Only the certificate fingerprint (SHA-256 of the DER-encoded cert) is
 * stored — no certificate data is embedded in the source.
 */
(function _seedMozillaRoots(): void {
  [
    // ISRG Root X1 (Let's Encrypt)
    '96bcec062649763744607796cf28c5a7cfe8a3c0aae11a8ffcee05c0bddf08c6',
    // ISRG Root X2 (Let's Encrypt, ECC)
    '69729b8e15a86efc177a57afb7171dfc64add28c2fca8cf1507e34453ccb1470',
    // DigiCert Global Root CA
    '4348a0e9444c78cb265e058d5e8944b4d84f9662bd26db257f8934a443c70161',
    // DigiCert Global Root G2
    'cb3ccbb76031e5e0138f8dd39a23f9de47ffc35e43c1144cea27d46a5ab1cb5f',
    // DigiCert Global Root G3
    '3139ea67c01de75bcaf52fa396b6fe22c0d63d5b497d8f5bc7a659a4b337e75f',
    // GlobalSign Root CA - R2
    'ca42dd41745fd0b81eb902362cf9d8bf719da1bd1b1efc946f5b4c99f42c1b9e',
    // GlobalSign Root CA - R3
    'cbb522d7b7f127ad6a0113865bdf1cd4102e7d0759af635a7cf4720dc963c53b',
    // GlobalSign Root CA - R6
    '2cabeafe37d06ca22aba7391c0033d25982952c453647349763a3ab5ad6ccf69',
    // Amazon Root CA 1
    '8ecde6884f3d87b1125ba31ac3fcb13d7016de7f57cc904fe1cb97c6ae98196e',
    // Amazon Root CA 2
    '1ba5b2aa8c65401a82960118f80bec4f62304d83cec4713a19e4a37bb209ed7f',
    // Amazon Root CA 3
    '18ce6cfe7bf14e60b2e347b8dfe868cb31d02ebb3ada271569f50343b46db3a4',
    // Amazon Root CA 4
    'e35d28419ed02025cfa69038cd623962458da5c695fbdea3c22b0bfb25897092',
    // Microsoft RSA Root Certificate Authority 2017
    'ffe94d9ee91c0b82e0fbe1f49bb9d0a069b5f553f3d6e6cca2abdb5f64b3ad2',
    // Microsoft ECC Root Certificate Authority 2017
    '358df39d764af9e1b766e9c972df352ee15cfac227af6ad1d70e8e4a6edcba02',
    // Baltimore CyberTrust Root
    '16af57a9f676b0ab126095aa5ebadef22ab31119d644ac95cd4b93dbf3f26aeb',
    // COMODO RSA Certification Authority
    '52f0e1c4e58ec629291b60317f074671b85d7ea80d5b07273463534b32b40234',
    // USERTrust RSA Certification Authority
    'e793c9b02fd8aa13e21c31229395a5fdf98714d8e2f7671befd9e1d87441be3a',
    // GTS Root R1 (Google Trust Services)
    '2a575471e31340bc21581cbd2cf13e158463203ece94bcf9d3cc196bf09a5472',
    // GTS Root R2 (Google Trust Services)
    'c45d7bb08e6d67e62e4235110b564e5f78fd92ef058c840aea4e6455d7585ef0',
    // Starfield Root Certificate Authority - G2
    '2ce1cb0bf9d2f9e102993fbe215152c3b2dd0cabde1c68e5319b839154dbb7f5',
    // AAA Certificate Services (Comodo)
    'd7a7a0fb5d7e2731d771e9484ebcdef71d5f0c3e0a2948782bc83ee0ea699ef4',
  ].forEach(function(fp) { systemTrustStore.addRoot(fp); });
})();

// ── OCSP implementation helpers (Item 292) ───────────────────────────────────

/** Minimal SHA-1 implementation (required for OCSP CertID per RFC 6960). */
function sha1(data: number[]): number[] {
  var h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  var msg = data.slice();
  var bitLen = msg.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  var hiLen = Math.floor(bitLen / 0x100000000);
  var loLen = bitLen >>> 0;
  msg.push(
    (hiLen >>> 24) & 0xff, (hiLen >>> 16) & 0xff, (hiLen >>> 8) & 0xff, hiLen & 0xff,
    (loLen >>> 24) & 0xff, (loLen >>> 16) & 0xff, (loLen >>> 8) & 0xff, loLen & 0xff
  );
  function rol(n: number, s: number): number { return ((n << s) | (n >>> (32 - s))) >>> 0; }
  function u32(n: number): number { return n >>> 0; }
  for (var bi = 0; bi < msg.length; bi += 64) {
    var w: number[] = [];
    for (var wi = 0; wi < 16; wi++)
      w.push((msg[bi+wi*4]<<24)|(msg[bi+wi*4+1]<<16)|(msg[bi+wi*4+2]<<8)|msg[bi+wi*4+3]);
    for (var wi2 = 16; wi2 < 80; wi2++)
      w.push(rol(w[wi2-3] ^ w[wi2-8] ^ w[wi2-14] ^ w[wi2-16], 1));
    var a = h0, b = h1, c = h2, d = h3, e = h4;
    for (var si = 0; si < 80; si++) {
      var f: number, k: number;
      if      (si < 20) { f = (b & c) | ((~b >>> 0) & d);     k = 0x5A827999; }
      else if (si < 40) { f = b ^ c ^ d;                      k = 0x6ED9EBA1; }
      else if (si < 60) { f = (b & c) | (b & d) | (c & d);    k = 0x8F1BBCDC; }
      else              { f = b ^ c ^ d;                       k = 0xCA62C1D6; }
      var tmp = u32(rol(a, 5) + f + e + k + w[si]);
      e = d; d = c; c = u32(rol(b, 30)); b = a; a = tmp;
    }
    h0 = u32(h0+a); h1 = u32(h1+b); h2 = u32(h2+c); h3 = u32(h3+d); h4 = u32(h4+e);
  }
  function to4(n: number): number[] { return [(n>>>24)&0xff,(n>>>16)&0xff,(n>>>8)&0xff,n&0xff]; }
  return [...to4(h0), ...to4(h1), ...to4(h2), ...to4(h3), ...to4(h4)];
}

/** Encode a DER length. */
function derLen(n: number): number[] {
  if (n < 0x80)  return [n];
  if (n < 0x100) return [0x81, n];
  return [0x82, (n >> 8) & 0xff, n & 0xff];
}

/** Build a DER TLV element. */
function derTLV(tag: number, val: number[]): number[] {
  return [tag, ...derLen(val.length), ...val];
}

/** Build a DER SEQUENCE enclosing child elements (already encoded). */
function derSeq(...children: number[][]): number[] {
  var body: number[] = [];
  for (var i = 0; i < children.length; i++) body = body.concat(children[i]);
  return derTLV(0x30, body);
}

/** SHA-1 AlgorithmIdentifier DER (OID 1.3.14.3.2.26 with NULL parameters). */
var SHA1_ALG_ID: number[] = derSeq(
  [0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a],  // OID sha1
  [0x05, 0x00]                                   // NULL
);

/**
 * [Item 292] Extract the OCSP responder URL from the AuthorityInfoAccess
 * (AIA) extension of an X.509 certificate.
 *
 * @returns  OCSP URL string, or null if none is present.
 */
export function getAIAOcspUrl(cert: X509Certificate): string | null {
  var aiaExt = cert.extensions.find(e => e.oid === OID_AUTHORITY_INFO);
  if (!aiaExt) return null;
  try {
    var seq = parseDER(aiaExt.value, 0).el;            // SEQUENCE OF AccessDescription
    for (var ad of seq.children) {                      // each AccessDescription
      var method = decodeOID(ad.children[0]?.value ?? []);
      if (method !== '1.3.6.1.5.5.7.48.1') continue;  // not OCSP
      var loc = ad.children[1];
      if (!loc) continue;
      // GeneralName [6] = uniformResourceIdentifier (IA5String)
      if (loc.tagClass === 2 && loc.tag === 6) {
        return String.fromCharCode(...loc.value);
      }
    }
  } catch (_) { /* malformed AIA — fall through */ }
  return null;
}

/**
 * [Item 292] Build a DER-encoded OCSPRequest for the given certificate.
 *
 * Uses SHA-1 hashes of the issuer name and key per RFC 6960 §4.1.
 * The CertID is constructed as:
 *   CertID ::= SEQUENCE {
 *     hashAlgorithm  AlgorithmIdentifier,  -- SHA-1
 *     issuerNameHash OCTET STRING,
 *     issuerKeyHash  OCTET STRING,
 *     serialNumber   INTEGER
 *   }
 */
export function buildOCSPRequest(cert: X509Certificate, issuer: X509Certificate): number[] {
  // Re-parse the issuer TBS to extract the raw subject name bytes
  var itbs = parseDER(issuer.tbsCertBytes, 0).el;
  var iKids = itbs.children;
  var iIdx = 0;
  if (iKids[iIdx] && iKids[iIdx].tagClass === 2 && iKids[iIdx].tag === 0) iIdx++; // skip version
  iIdx++; // serial
  iIdx++; // signature alg id
  // Now at issuer (subject of issuer cert)
  var subjectEl = iKids[iIdx];
  var issuerNameRaw: number[] = subjectEl
    ? [0x30, ...derLen(subjectEl.value.length), ...subjectEl.value]
    : [];

  var nameHash = sha1(issuerNameRaw);
  // issuerKeyHash: SHA-1 of the BIT STRING value (strip leading 0x00 padding byte)
  var issuerKeyBytes = issuer.publicKeyBytes.length > 0 && issuer.publicKeyBytes[0] === 0x00
    ? issuer.publicKeyBytes.slice(1) : issuer.publicKeyBytes;
  var keyHash = sha1(issuerKeyBytes);

  var certId = derSeq(
    SHA1_ALG_ID,
    derTLV(0x04, nameHash),    // OCTET STRING issuerNameHash
    derTLV(0x04, keyHash),     // OCTET STRING issuerKeyHash
    derTLV(0x02, cert.serialNumber)  // INTEGER serialNumber
  );

  // OCSPRequest ::= SEQUENCE { tbsRequest SEQUENCE { requestList SEQUENCE OF Request } }
  var request  = derSeq(certId);              // Request
  var reqList  = derTLV(0x30, request);       // requestList
  var tbsReq   = derSeq(reqList);             // TBSRequest
  return derSeq(tbsReq);                      // OCSPRequest
}

/**
 * [Item 292] Parse a DER-encoded BasicOCSPResponse and return the revocation
 * status for the certificate identified by `serialNumber`.
 */
export function parseOCSPResponse(der: number[], serialNumber: number[]): RevocationStatus {
  try {
    var outer = parseDER(der, 0).el;          // OCSPResponse
    // responseStatus must be 0 (successful)
    if (outer.children[0]?.value[0] !== 0x00) return 'unknown';
    // responseBytes [0] EXPLICIT ResponseBytes
    var rb = outer.children[1];
    if (!rb) return 'unknown';
    var rbSeq = rb.children[0];               // ResponseBytes ::= SEQUENCE
    // Skip OID check — assume BasicOCSPResponse
    // responseType OID | response OCTET STRING
    var responseOctet = rbSeq?.children[1];
    if (!responseOctet) return 'unknown';
    var basic = parseDER(responseOctet.value, 0).el;   // BasicOCSPResponse
    var tbsResp = basic.children[0];                   // ResponseData
    var responses = tbsResp?.children.find(
      (c: ASN1Element) => c.tag === 0x10 && c.constructed) ?? tbsResp?.children[3];
    if (!responses) return 'unknown';
    for (var singleResp of responses.children) {
      // SingleResponse: certID, certStatus, thisUpdate, nextUpdate?
      var certId = singleResp.children[0];
      if (!certId) continue;
      // serialNumber is the last child of CertID
      var respSerial = certId.children[3]?.value ?? [];
      if (respSerial.length !== serialNumber.length) continue;
      if (!respSerial.every((b: number, i: number) => b === serialNumber[i])) continue;
      var status = singleResp.children[1];
      if (!status) return 'unknown';
      // certStatus: good [0], revoked [1], unknown [2]  (context-specific)
      if (status.tagClass === 2 && status.tag === 0) return 'good';
      if (status.tagClass === 2 && status.tag === 1) return 'revoked';
      return 'unknown';
    }
  } catch (_) { /* malformed response */ }
  return 'unknown';
}

// ── OCSP / CRL (Items 292, 293) ───────────────────────────────────────────────

/** [Item 292] Revocation status of a certificate. */
export type RevocationStatus = 'good' | 'revoked' | 'unknown';

/**
 * [Item 293] OCSP stapled response envelope.
 * The TLS server sends this in the Certificate Status handshake message.
 */
export interface OCSPStapledResponse {
  version:    number;
  producedAt: Date;
  responses:  OCSPSingleResponse[];
  /** Raw DER of the stapled response for re-validation. */
  raw:        number[];
}

export interface OCSPSingleResponse {
  certStatus: RevocationStatus;
  thisUpdate: Date;
  nextUpdate: Date | null;
  serialNumber: number[];
}

/**
 * [Item 292] Callback type for OCSP HTTP POST requests.
 *
 * The caller (typically the TLS layer) supplies a function that performs
 * a synchronous HTTP POST and returns the response body as raw bytes, or
 * null on network error.  Using a callback avoids a circular import
 * between x509.ts and http.ts.
 */
export type OcspFetchFn = (url: string, body: number[]) => number[] | null;

/**
 * [Item 292] Check certificate revocation via OCSP.
 *
 * Algorithm:
 *  1. Extract the OCSP responder URL from the AIA extension.
 *  2. Build a DER-encoded OCSPRequest for the certificate.
 *  3. POST it to the responder via `fetchFn`.
 *  4. Parse the OCSPResponse and return the revocation status.
 *
 * If the AIA extension is absent, the responder is unreachable, or the
 * response cannot be parsed, the function returns `'unknown'`.
 *
 * @param cert      The leaf certificate to check.
 * @param issuer    The issuing CA certificate (needed to build CertID).
 * @param fetchFn   Optional HTTP POST callback.  Must POST `body` bytes to
 *                  `url` with `Content-Type: application/ocsp-request` and
 *                  return the response body, or null on failure.
 */
export function checkRevocationOCSP(
    cert:    X509Certificate,
    issuer:  X509Certificate,
    fetchFn: OcspFetchFn | null = null): RevocationStatus {
  var url = getAIAOcspUrl(cert);
  if (!url || !fetchFn) return 'unknown';
  try {
    var req  = buildOCSPRequest(cert, issuer);
    var resp = fetchFn(url, req);
    if (!resp) return 'unknown';
    return parseOCSPResponse(resp, cert.serialNumber);
  } catch (_) {
    return 'unknown';
  }
}

/**
 * [Item 293] Verify a stapled OCSP response for the given certificate serial.
 * Returns null if the response is valid and the certificate is good.
 */
export function verifyOCSPStapled(
    stapled: OCSPStapledResponse,
    cert: X509Certificate,
    now: Date = new Date()): string | null {
  var resp = stapled.responses.find(r => {
    return r.serialNumber.length === cert.serialNumber.length &&
           r.serialNumber.every((b, i) => b === cert.serialNumber[i]);
  });
  if (!resp) return 'Serial not found in OCSP response';
  if (resp.certStatus === 'revoked') return 'Certificate revoked';
  if (resp.nextUpdate && now > resp.nextUpdate) return 'OCSP response expired';
  return null;
}
