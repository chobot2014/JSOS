# JSOS Security Policy
**Item 891**

## Supported Versions

| Version | Security fixes |
|---------|---------------|
| main    | ✅ Yes         |
| tags    | ✅ Last 2 tags |
| older   | ❌ No          |

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Email: `security@jsos.dev`

Include:
- Description of the vulnerability
- Steps to reproduce
- Impact assessment
- CVE reference (if applicable)

You will receive an acknowledgement within 48 hours and a patch timeline within 7 days.

## Security Model

JSOS is a bare-metal OS; its security model differs from application security:

### Boot Security
- Secure Boot: JSOS signs `bundle.js` with a private key; the GRUB shim verifies the signature at boot
- `bundle.crc` is a CRC32 integrity check (not a cryptographic signature; use Secure Boot for true boot integrity)
- KASLR: Kernel base address is randomised at runtime via RDRAND

### Memory Safety
- The kernel (QuickJS VM + C HAL) runs in ring 0 with full hardware access
- User JavaScript code runs in a QuickJS context with no direct hardware access
- System calls are the only bridge; arguments are range-checked before being forwarded to hardware

### Network
- TLS 1.3 (ECDHE-AES-GCM) for all outbound HTTPS
- Certificate chain validation against the bundled Mozilla root CA set
- No TLS 1.1 or SSLv3 support

### Filesystem
- POSIX permission bits (rwxrwxrwx) enforced by the VFS layer
- Root account is required for `/dev`, `/proc`, `/sys` modifications
- Disk encryption: todo (item 905)

### Known Limitations
- The JIT compiler (`src/kernel/jit.c`) executes generated machine code; malicious JS payloads could craft JIT primitives — treat untrusted JS with care
- UDP is unauthenticated; DTLS is not yet implemented
- SELinux/AppArmor equivalent: not yet implemented (item P3)
