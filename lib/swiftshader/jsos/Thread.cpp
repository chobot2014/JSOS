/**
 * JSOS SwiftShader Platform Bridge — Thread
 *
 * Routes SwiftShader worker-thread creation requests to the JSOS TypeScript
 * ThreadManager (Phase 5).  SwiftShader creates one worker per CPU core for
 * parallel rasterization; JSOS maps each to a cooperative kernel thread.
 *
 * Compilation note: this file is part of jsos_swiftshader_platform.a and
 * links against the JSOS kernel via the C binding layer.
 */

#include <stddef.h>
#include <stdint.h>

// ── JSOS kernel C bindings ────────────────────────────────────────────────

extern "C" {
  // Phase 5 thread manager
  // fn: function pointer to void(*)(void*)
  // arg: opaque argument passed to fn
  // Returns an opaque thread handle (> 0 on success)
  uint32_t jsos_thread_create(void (*fn)(void*), void* arg);
  void     jsos_thread_join(uint32_t handle);
  void     jsos_thread_yield(void);

  // Mutex primitives (backed by Phase 5 Mutex class via C shim)
  uint32_t jsos_mutex_create(void);
  void     jsos_mutex_lock(uint32_t handle);
  void     jsos_mutex_unlock(uint32_t handle);
  void     jsos_mutex_destroy(uint32_t handle);
}

// ── SwiftShader thread abstraction ────────────────────────────────────────

extern "C" {

typedef void (*sw_ThreadFunc)(void*);

/**
 * Create a new OS thread running fn(arg).
 * Returns an opaque handle; 0 on failure.
 */
uint32_t sw_createThread(sw_ThreadFunc fn, void* arg) {
  return jsos_thread_create(fn, arg);
}

/**
 * Block until the thread identified by `handle` has finished.
 */
void sw_joinThread(uint32_t handle) {
  jsos_thread_join(handle);
}

/**
 * Yield the current thread's timeslice to allow other threads to run.
 * Called by SwiftShader's work-stealing scheduler between rasterization tasks.
 */
void sw_yieldThread(void) {
  jsos_thread_yield();
}

// ── Mutex helpers used by SwiftShader's internal synchronisation ──────────

uint32_t sw_createMutex(void)           { return jsos_mutex_create();         }
void     sw_lockMutex(uint32_t h)       { jsos_mutex_lock(h);                 }
void     sw_unlockMutex(uint32_t h)     { jsos_mutex_unlock(h);               }
void     sw_destroyMutex(uint32_t h)    { jsos_mutex_destroy(h);              }

} // extern "C"
