/**
 * syscall-policy.ts — Syscall allowlist / deny-list for per-process API access control
 *
 * Implements item 167: TypeScript wrapper that restricts which `sys.*` APIs a process
 * can call.  The `SyscallPolicy` class wraps the global `sys` object and proxies each
 * call through an access-control check before delegating to the real implementation.
 *
 * ## Model
 *
 *   - Each process has an associated `SyscallPolicy` (stored in ProcessContext).
 *   - The policy contains a `Set<string>` of allowed top-level API names.
 *   - When a process calls `sys.net.createSocket()`, the interceptor checks if `"net"`
 *     is in its allowlist before forwarding the call.
 *   - Denied calls throw a `SyscallDeniedError` (which the init system catches and
 *     delivers as SIGPWR / SIGABRT, depending on configuration).
 *
 * ## Pre-defined policy profiles
 *
 *   | Profile       | Allowed namespaces                                     |
 *   |---------------|--------------------------------------------------------|
 *   | `sandbox`     | `proc`, `io` (terminal only), no net / fs / vm        |
 *   | `restricted`  | `proc`, `io`, `fs` (read-only paths only)              |
 *   | `standard`    | `proc`, `io`, `fs`, `net`, `ipc`                       |
 *   | `privileged`  | all namespaces (same as no policy)                     |
 *
 * ## Usage
 *
 *   ```typescript
 *   import { SyscallPolicy, POLICY_SANDBOX } from './syscall-policy.js';
 *
 *   // Create a restricted sys proxy for an untrusted process:
 *   const policy = new SyscallPolicy(POLICY_SANDBOX);
 *   const safeSys = policy.wrap(sys);
 *
 *   // Pass safeSys to process instead of the real sys object.
 *   // sys.net.createSocket() on safeSys throws SyscallDeniedError.
 *   ```
 */

/** Error thrown when a process attempts a denied syscall. */
export class SyscallDeniedError extends Error {
  constructor(
    public readonly namespace: string,
    public readonly method:    string,
    public readonly pid:       number,
  ) {
    super(`[syscall-policy] pid ${pid}: access denied — ${namespace}.${method}()`);
    this.name = 'SyscallDeniedError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Pre-defined policy profiles
// ─────────────────────────────────────────────────────────────────────────────

/** Allowed namespace sets for each profile. */
export type PolicyProfile = 'sandbox' | 'restricted' | 'standard' | 'privileged';

const PROFILE_NAMESPACES: Record<PolicyProfile, Set<string>> = {
  sandbox:    new Set(['proc', 'io']),
  restricted: new Set(['proc', 'io', 'fs']),
  standard:   new Set(['proc', 'io', 'fs', 'net', 'ipc', 'storage']),
  privileged: new Set(['*']),  // wildcard — all namespaces
};

/** Method-level deny list: even in `privileged` mode, these are always blocked. */
const ALWAYS_DENIED: ReadonlyMap<string, Set<string>> = new Map<string, Set<string>>([
  ['kernel', new Set(['shutdown', 'reboot', 'panic'])],
  ['vm',     new Set(['killAll', 'wipeMem'])],
]);

// ─────────────────────────────────────────────────────────────────────────────
//  SyscallPolicy
// ─────────────────────────────────────────────────────────────────────────────

export class SyscallPolicy {
  private readonly _allowed: Set<string>;
  private readonly _extraDeny: Map<string, Set<string>>;
  private _pid: number;
  private _auditLog: Array<{ pid: number; ns: string; method: string; allowed: boolean; ts: number }> = [];
  private _auditEnabled = false;

  constructor(
    profile: PolicyProfile = 'standard',
    pid = 0,
    extraDeny: Map<string, Set<string>> = new Map(),
  ) {
    this._allowed   = new Set(PROFILE_NAMESPACES[profile]);
    this._pid       = pid;
    this._extraDeny = extraDeny;
    // Merge always-denied rules
    for (const [ns, methods] of ALWAYS_DENIED) {
      const set = this._extraDeny.get(ns) ?? new Set<string>();
      for (const m of methods) set.add(m);
      this._extraDeny.set(ns, set);
    }
  }

  /** Attach this policy to a specific PID. */
  setPid(pid: number): void { this._pid = pid; }

  /** Enable audit logging of every syscall (allowed + denied). */
  enableAudit(): void { this._auditEnabled = true; }
  /** Return recent audit log entries. */
  auditLog(): ReadonlyArray<{ pid: number; ns: string; method: string; allowed: boolean; ts: number }> {
    return this._auditLog;
  }

  /** Explicitly grant access to a namespace at runtime. */
  grant(namespace: string): void { this._allowed.add(namespace); }

  /** Revoke access to a namespace at runtime. */
  revoke(namespace: string): void { this._allowed.delete(namespace); }

  /**
   * Check whether a call to `namespace.method()` is permitted.
   * Throws `SyscallDeniedError` if denied.
   */
  check(namespace: string, method: string): void {
    const allowed = this._isAllowed(namespace, method);
    if (this._auditEnabled) {
      this._auditLog.push({
        pid: this._pid, ns: namespace, method,
        allowed, ts: typeof Date !== 'undefined' ? Date.now() : 0,
      });
      if (this._auditLog.length > 512) this._auditLog.shift(); // rolling window
    }
    if (!allowed) throw new SyscallDeniedError(namespace, method, this._pid);
  }

  private _isAllowed(namespace: string, method: string): boolean {
    // Always-denied rules override everything
    const denySet = this._extraDeny.get(namespace);
    if (denySet?.has(method)) return false;

    // Privileged wildcard: allow all (except always-denied above)
    if (this._allowed.has('*')) return true;

    // Check namespace-level allowlist
    return this._allowed.has(namespace);
  }

  /**
   * Wrap a `sys`-like object with this policy.  Returns a Proxy that intercepts
   * all namespace-level property accesses and method calls.
   *
   * @param sysObj  The real `sys` object (or any flat namespace-of-namespaces obj)
   * @returns       A proxy that enforces this policy
   */
  wrap<T extends object>(sysObj: T): T {
    const policy = this;
    return new Proxy(sysObj, {
      get(target: T, ns: string | symbol): unknown {
        if (typeof ns !== 'string') return (target as Record<string | symbol, unknown>)[ns];
        const nsObj = (target as Record<string, unknown>)[ns];
        if (typeof nsObj !== 'object' || nsObj === null) {
          // Scalar property — no interception needed
          return nsObj;
        }
        // Return a Proxy wrapping the namespace object that intercepts method calls
        return new Proxy(nsObj as object, {
          get(nsTarget: object, method: string | symbol): unknown {
            if (typeof method !== 'string') return (nsTarget as Record<string | symbol, unknown>)[method];
            const fn = (nsTarget as Record<string, unknown>)[method];
            if (typeof fn !== 'function') return fn;
            // Return a wrapped function that checks policy before calling
            return function (...args: unknown[]): unknown {
              policy.check(ns, method);
              return (fn as Function).apply(nsTarget, args);
            };
          },
        });
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Global policy registry — map pid → SyscallPolicy
//  Accessed by the process manager on fork() / exec() / exit().
// ─────────────────────────────────────────────────────────────────────────────

const _policyRegistry = new Map<number, SyscallPolicy>();

/** Register a policy for a PID (called on process creation). */
export function registerPolicy(pid: number, policy: SyscallPolicy): void {
  policy.setPid(pid);
  _policyRegistry.set(pid, policy);
}

/** Remove policy entry on process exit. */
export function unregisterPolicy(pid: number): void {
  _policyRegistry.delete(pid);
}

/** Get the policy for a PID, or a privileged default if none registered. */
export function getPolicy(pid: number): SyscallPolicy {
  return _policyRegistry.get(pid) ?? new SyscallPolicy('privileged', pid);
}

/** Convenience: create a sandbox policy for a new process inherited from parent.
 *  Child inherits the parent's profile but starts with a clean audit log.
 */
export function forkPolicy(parentPid: number, childPid: number): SyscallPolicy {
  const parent = _policyRegistry.get(parentPid);
  // Derive profile from parent's allowed namespaces
  let profile: PolicyProfile = 'standard';
  if (parent) {
    const allowed = (parent as unknown as { _allowed: Set<string> })['_allowed'];
    if (allowed?.has('*'))    profile = 'privileged';
    else if (!allowed?.has('net')) profile = 'restricted';
  }
  const child = new SyscallPolicy(profile, childPid);
  _policyRegistry.set(childPid, child);
  return child;
}
