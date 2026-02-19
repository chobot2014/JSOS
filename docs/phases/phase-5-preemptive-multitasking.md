# Phase 5 — Preemptive Multitasking & Threads

## Goal

Real context switching via the timer interrupt. Multiple independent threads
each with their own stack. Synchronisation primitives (mutex, condvar,
semaphore) that underpin the POSIX threading model required by Phase 6.

---

## Prerequisites

- Phase 4 complete (real page tables, kernel/user split)
- `PhysicalAllocator` available to back per-thread kernel stacks

---

## The C Code Rule Applied Here

Context switching requires saving and restoring CPU registers, which cannot be
expressed in TypeScript. The rule is:

> C saves the current register state, calls TypeScript to ask "who runs next?",
> receives the answer, loads the new register state, and `iret`s. All scheduling
> logic is TypeScript.

C knows nothing about threads, priorities, or scheduling algorithms.

---

## 5a — IRQ0 Preemptive Context Switch

### Current (Phase 1)

IRQ0 fires, increments a tick counter in C, and returns. TypeScript yields
voluntarily with `scheduler.yield()`.

### Phase 5 Change

IRQ0 fires, saves **full CPU state** to the current thread's stack, calls
`js_scheduler_tick()` in TypeScript, receives the new thread's stack pointer,
loads that state, and `iret`s into the new thread.

```c
// irq_asm.s — IRQ0 preemptive entry (replaces old handler):
irq0_entry:
  // 1. Save all registers to current kernel stack
  pusha
  push ds; push es; push fs; push gs
  // 2. Call TypeScript: "give me the next stack pointer"
  call js_scheduler_tick
  // eax = new thread's saved ESP (TypeScript return value)
  // 3. Load new stack
  mov esp, eax
  // 4. Restore new thread's registers
  pop gs; pop fs; pop es; pop ds
  popa
  iret

// C bridge called from the assembly stub:
extern uint32_t js_scheduler_tick(void);
// TypeScript's scheduler runs, returns new thread's saved ESP.
// If the same thread is re-scheduled, returns the current ESP unchanged.
```

### QuickJS Callback

```c
// In quickjs_binding.c — new binding:
kernel.registerSchedulerHook(fn: Function): void
// TypeScript calls this at init to register the scheduler tick function.
// js_scheduler_tick() calls fn() and returns its number return value.
```

C code in `js_scheduler_tick` is ~10 lines. The scheduling algorithm is zero
lines of C.

---

## 5b — Thread Model (TypeScript — src/os/process/threads.ts)

```typescript
interface CPUContext {
  // Saved register layout matching pusha + segment push order in irq_asm.s
  gs: number; fs: number; es: number; ds: number
  edi: number; esi: number; ebp: number; esp: number
  ebx: number; edx: number; ecx: number; eax: number
  eip: number; cs: number; eflags: number
  userESP?: number; userSS?: number   // only when switching from ring 3
}

type ThreadState = 'ready' | 'running' | 'blocked' | 'sleeping' | 'dead'

class Thread {
  tid: number
  pid: number                    // owning process (Phase 6)
  name: string
  state: ThreadState
  priority: number               // 0 (highest) – 39
  kernelStack: number            // physical address of 64KB kernel stack
  savedESP: number               // current ESP within kernelStack
  sleepUntil: number             // tick count (0 = not sleeping)
  blockedOn: Mutex | null        // synchronisation blocker
  errno: number                  // per-thread errno (POSIX)
}

class ThreadManager {
  // Create a new kernel thread. entryPoint is a virtual address.
  createKernelThread(name: string, entryPoint: number,
                     stackSize?: number): Thread

  // Called by IRQ0 handler via kernel.registerSchedulerHook
  tick(): number                 // returns new thread's savedESP

  // Thread control
  exitThread(tid: number, code: number): void
  blockThread(tid: number, reason: Mutex | 'io' | 'sleep'): void
  unblockThread(tid: number): void
  sleepThread(tid: number, ms: number): void

  // Scheduler algorithm (replaceable)
  private schedule(): Thread     // pick next ready thread
}
```

### Scheduling Algorithm

Default: **multi-level priority round-robin** in TypeScript.

```typescript
private schedule(): Thread {
  // 1. Wake any sleeping threads whose sleepUntil <= currentTick
  // 2. Pick highest-priority ready thread
  // 3. Among same-priority threads: round-robin
  // 4. Idle thread if nothing ready (HLT loop in C)
  return nextThread
}
```

The algorithm is a pure TypeScript function with no C involvement. Replacing
it with CFS or real-time scheduling requires no C changes.

---

## 5c — TSS (Task State Segment)

When transitioning from ring 3 (user) to ring 0 (kernel) on an interrupt,
the CPU needs to know what kernel stack to use. It reads this from the TSS.

```c
// New C functions (minimal, called once):
void tss_init(void);        // zero-fills TSS, loads TR selector
void tss_set_esp0(uint32_t kernel_stack_top);  // updates TSS.ESP0

// QuickJS binding:
kernel.tssSetESP0(addr: number): void
// TypeScript calls this when switching to a new thread to update
// the TSS.ESP0 so interrupts from ring 3 use the right kernel stack.
```

TypeScript (ThreadManager) owns the TSS logical structure. C writes the
hardware register.

---

## 5d — Synchronisation Primitives (TypeScript — src/os/process/sync.ts)

All primitives in TypeScript. No spinlocks in this phase (single-core only;
Phase 10 adds SMP spinlocks).

```typescript
class Mutex {
  private owner: Thread | null = null
  private waitQueue: Thread[] = []

  lock(): void {
    if (this.owner === null) {
      this.owner = currentThread()
    } else {
      threadManager.blockThread(currentThread().tid, this)
      // scheduler picks another thread; we resume here when unlocked
    }
  }

  unlock(): void {
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!
      this.owner = next
      threadManager.unblockThread(next.tid)
    } else {
      this.owner = null
    }
  }

  tryLock(): boolean {
    if (this.owner !== null) return false
    this.owner = currentThread()
    return true
  }
}

class Condvar {
  private waitQueue: Thread[] = []

  wait(mutex: Mutex): void {
    mutex.unlock()
    threadManager.blockThread(currentThread().tid, 'io')
    // resumes after signal/broadcast
    mutex.lock()
  }

  signal(): void {
    if (this.waitQueue.length > 0)
      threadManager.unblockThread(this.waitQueue.shift()!.tid)
  }

  broadcast(): void {
    while (this.waitQueue.length > 0)
      threadManager.unblockThread(this.waitQueue.shift()!.tid)
  }
}

class Semaphore {
  private count: number
  private waitQueue: Thread[] = []

  constructor(initial: number) { this.count = initial }

  acquire(): void {
    if (this.count > 0) { this.count--; return }
    threadManager.blockThread(currentThread().tid, 'io')
  }

  release(): void {
    if (this.waitQueue.length > 0)
      threadManager.unblockThread(this.waitQueue.shift()!.tid)
    else
      this.count++
  }
}
```

These are the foundations for `pthread_mutex_t`, `pthread_cond_t`, and `sem_t`
in Phase 6's POSIX layer.

---

## Idle Thread

When no threads are ready, the scheduler returns a special idle thread whose
entry point is a C `hlt` loop:

```c
void idle_thread_entry(void) {
  while (1) { __asm__ volatile("hlt"); }
}
```

TypeScript creates this thread at boot and never marks it as anything other
than the fallback choice.

---

## New / Modified C

| File | Change |
|---|---|
| `irq_asm.s` | Replace IRQ0 stub with full register save/restore |
| `irq.c` | Add `js_scheduler_tick` C bridge |
| `platform.c` | Add `tss_init`, `tss_set_esp0` |
| `quickjs_binding.c` | Add `kernel.registerSchedulerHook`, `kernel.tssSetESP0` |

## New TypeScript Files

| File | Description |
|---|---|
| `src/os/process/threads.ts` | Thread class + ThreadManager |
| `src/os/process/sync.ts` | Mutex, Condvar, Semaphore |

## Modified TypeScript Files

| File | Change |
|---|---|
| `src/os/process/scheduler.ts` | Integrate with ThreadManager; delegate `tick()` |
| `src/os/core/kernel.ts` | Add `registerSchedulerHook`, `tssSetESP0` bindings |

---

## Test Oracle

```
[SERIAL] Preemptive scheduler active (100Hz)
[SERIAL] Thread 0 (idle) created
[SERIAL] Thread 1 (repl) created
[SERIAL] Context switch test: PASS
[SERIAL] Mutex contention test: PASS
[SERIAL] REPL ready
```

---

## What Phase 5 Does NOT Do

- ❌ No user-space threads (ring 3) — Phase 6 adds user processes
- ❌ No clone/fork — Phase 6
- ❌ No SMP (single core only) — Phase 10
- ❌ No real-time scheduling class (can be added to `schedule()` function)
- ❌ No futex — Phase 6 POSIX layer adds futex over Mutex
