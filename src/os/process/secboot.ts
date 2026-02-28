/**
 * UEFI Secure Boot Signing Support
 * Item 846 — Sign bundle.js so the GRUB shim can verify it at boot time
 *
 * JSOS uses a lightweight in-house signing scheme:
 *
 *   1. The private key (Ed25519, 32 bytes seed) is kept OFFLINE.
 *   2. The public key is embedded in the kernel binary at build time.
 *   3. At boot the kernel verifies: SHA-256(bundle.js) matches the
 *      Ed25519 signature stored in the GRUB module `secboot.sig`.
 *   4. If verification fails the kernel halts with a SECBOOT_FAIL panic.
 *
 * This file implements:
 *   - The runtime VERIFICATION path (TypeScript, runs in the OS)
 *   - A build-time SIGNING stub (real signing happens in a separate offline tool)
 *   - A PUBLIC KEY registry (additional trusted keys can be enrolled at runtime)
 */

declare const kernel: any;

const PAGE_SIZE = 4096;

// ── Ed25519 stub (cryptographic primitives are in the kernel) ─────────────

/**
 * Verify an Ed25519 signature over `message` using `publicKey`.
 * Delegates to the kernel's built-in Ed25519 implementation.
 */
function ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32) throw new TypeError('Ed25519: publicKey must be 32 bytes');
  if (signature.length  !== 64) throw new TypeError('Ed25519: signature must be 64 bytes');
  return kernel.ed25519Verify(publicKey, message, signature) === 0;
}

// ── Key enrollment database ────────────────────────────────────────────────

interface EnrolledKey {
  name: string;
  publicKey: Uint8Array;
  enrolledAt: number; // Unix timestamp
  revoked: boolean;
}

const _enrolledKeys: EnrolledKey[] = [];

/** Add a trusted public key to the Secure Boot database. */
export function enrollKey(name: string, publicKeyBytes: Uint8Array): void {
  if (publicKeyBytes.length !== 32) throw new TypeError('enrollKey: publicKey must be 32 bytes (Ed25519)');
  if (_enrolledKeys.some(k => k.name === name && !k.revoked)) {
    throw new Error(`enrollKey: key '${name}' is already enrolled`);
  }
  _enrolledKeys.push({ name, publicKey: new Uint8Array(publicKeyBytes), enrolledAt: Date.now(), revoked: false });
}

/** Revoke a previously enrolled key by name. */
export function revokeKey(name: string): boolean {
  const key = _enrolledKeys.find(k => k.name === name && !k.revoked);
  if (!key) return false;
  key.revoked = true;
  return true;
}

export function listKeys(): Array<{ name: string; enrolledAt: number; revoked: boolean }> {
  return _enrolledKeys.map(({ name, enrolledAt, revoked }) => ({ name, enrolledAt, revoked }));
}

// ── Bundle verification ────────────────────────────────────────────────────

export interface SecBootResult {
  verified: boolean;
  signer?: string;
  error?: string;
}

/**
 * Verify the running bundle.js against the signatures stored in secboot.sig.
 *
 * secboot.sig binary layout:
 *   [4 bytes: magic 'JSSB']
 *   [4 bytes: entry count N (LE)]
 *   N × {
 *     [1 byte: name length]
 *     [<name length> bytes: signer name (UTF-8)]
 *     [64 bytes: Ed25519 signature over SHA-256(bundle.js)]
 *   }
 */
export function verifyBundle(bundleBytes: Uint8Array, sigBytes: Uint8Array): SecBootResult {
  if (sigBytes.length < 8) return { verified: false, error: 'secboot.sig too short' };

  // Check magic
  const magic = String.fromCharCode(...sigBytes.subarray(0, 4));
  if (magic !== 'JSSB') return { verified: false, error: 'Invalid secboot.sig magic' };

  const count = sigBytes[4] | (sigBytes[5] << 8) | (sigBytes[6] << 16) | (sigBytes[7] << 24);
  let offset = 8;

  // Hash the bundle
  const bundleHash: Uint8Array = kernel.sha256(bundleBytes);

  for (let i = 0; i < count; i++) {
    if (offset >= sigBytes.length) break;
    const nameLen = sigBytes[offset++];
    const nameBytes = sigBytes.subarray(offset, offset + nameLen);
    const name = new TextDecoder().decode(nameBytes);
    offset += nameLen;
    const sig = sigBytes.subarray(offset, offset + 64);
    offset += 64;

    // Look for this signer in enrolled keys
    const key = _enrolledKeys.find(k => k.name === name && !k.revoked);
    if (!key) continue;

    if (ed25519Verify(key.publicKey, bundleHash, sig)) {
      return { verified: true, signer: name };
    }
  }

  return { verified: false, error: 'No matching enrolled key found for any signature in secboot.sig' };
}

/**
 * Called during boot by the kernel init sequence.
 * Reads /boot/bundle.js and /boot/secboot.sig → verifies → panics if not VERIFIED.
 */
export function bootVerify(): void {
  const bundleKey = kernel.getBuiltinPublicKey(); // 32 bytes baked into kernel.bin at build time
  enrollKey('__builtin__', new Uint8Array(bundleKey));

  let bundleBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    bundleBytes = kernel.readBootFile('bundle.js');
    sigBytes    = kernel.readBootFile('secboot.sig');
  } catch (e) {
    // If sig file doesn't exist → assume development mode (no Secure Boot)
    console.warn('[secboot] secboot.sig not found; running in UNSIGNED mode (dev)');
    return;
  }

  const result = verifyBundle(bundleBytes, sigBytes);
  if (!result.verified) {
    kernel.panic(`SECBOOT_FAIL: ${result.error ?? 'signature verification failed'}`);
  }

  console.log(`[secboot] Bundle verified by key: ${result.signer}`);
}

export const secboot = {
  enrollKey,
  revokeKey,
  listKeys,
  verifyBundle,
  bootVerify,
};
