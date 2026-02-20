// Copyright 2024 The JSOS Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license.

// JSOS Event Source — Phase 9
//
// Polls the JSOS kernel for keyboard and mouse events and converts them to
// Chromium ui::Event objects.  The JSOS kernel exposes two polling APIs:
//
//   kernel.readKey()    → KeyEvent | null    (Phase 1 keyboard.c)
//   kernel.readMouse()  → {dx, dy, buttons} | null  (Phase 3 mouse.c)
//
// Both are called via the QuickJS bindings.  Since exec() moves Chromium to
// ring-3 and the JS runtime is in ring-0, we read events via a custom JSOS
// syscall (int 0x80 / SYS_KEY_READ = 0x50, SYS_MOUSE_READ = 0x51) injected
// by Phase 9.

#include "chromium/ui/ozone/platform/jsos/jsos_event_source.h"

#include <unistd.h>

#include "chromium/base/message_loop/message_pump_default.h"
#include "chromium/ui/events/event.h"
#include "chromium/ui/events/keycodes/keyboard_codes.h"
#include "chromium/ui/events/platform/platform_event_source.h"

// JSOS custom syscall numbers for event polling from ring-3.
#define JSOS_SYS_KEY_READ    0x50
#define JSOS_SYS_MOUSE_READ  0x51

namespace ui {

namespace {

// Read one keystroke from the JSOS kernel.
// Returns 0 if the key queue is empty.
static int jsos_read_key(void) {
  int result;
  __asm__ volatile(
      "int $0x80"
      : "=a"(result)
      : "a"(JSOS_SYS_KEY_READ)
      : "memory"
  );
  return result;
}

struct JsosMousePacket {
  int dx;
  int dy;
  int buttons;
  int valid;
};

// Read one mouse packet from the JSOS kernel.
static JsosMousePacket jsos_read_mouse(void) {
  JsosMousePacket pkt = {0, 0, 0, 0};
  int result, dx, dy, buttons;
  __asm__ volatile(
      "int $0x80"
      : "=a"(result), "=b"(dx), "=c"(dy), "=d"(buttons)
      : "a"(JSOS_SYS_MOUSE_READ)
      : "memory"
  );
  if (result) {
    pkt.valid   = 1;
    pkt.dx      = dx;
    pkt.dy      = dy;
    pkt.buttons = buttons;
  }
  return pkt;
}

// JSOS extended key code definitions (must match keyboard.h).
// Returned by JSOS_SYS_KEY_READ when keyboard_poll() == 0 but
// keyboard_get_extended() is non-zero.
#define JSOS_KEY_UP       0x80
#define JSOS_KEY_DOWN     0x81
#define JSOS_KEY_LEFT     0x82
#define JSOS_KEY_RIGHT    0x83
#define JSOS_KEY_HOME     0x84
#define JSOS_KEY_END      0x85
#define JSOS_KEY_PAGEUP   0x86
#define JSOS_KEY_PAGEDOWN 0x87
#define JSOS_KEY_DELETE   0x88
#define JSOS_KEY_F1       0x90
#define JSOS_KEY_F2       0x91
#define JSOS_KEY_F3       0x92
#define JSOS_KEY_F4       0x93
#define JSOS_KEY_F5       0x94
#define JSOS_KEY_F6       0x95
#define JSOS_KEY_F7       0x96
#define JSOS_KEY_F8       0x97
#define JSOS_KEY_F9       0x98
#define JSOS_KEY_F10      0x99
#define JSOS_KEY_F11      0x9A
#define JSOS_KEY_F12      0x9B

// Convert a JSOS key code (from JSOS_SYS_KEY_READ) to a Chromium KeyboardCode.
// The JSOS kernel returns either:
//   1-127  : ASCII character from the translated keyboard buffer.
//   0x80+  : JSOS extended key code for special keys (arrows, F-keys, …).
static ui::KeyboardCode JsosKeyToVKey(int code) {
  // ASCII printable characters and common control keys.
  if (code >= 'a' && code <= 'z')
    return static_cast<ui::KeyboardCode>(ui::VKEY_A + code - 'a');
  if (code >= 'A' && code <= 'Z')
    return static_cast<ui::KeyboardCode>(ui::VKEY_A + code - 'A');
  if (code >= '0' && code <= '9')
    return static_cast<ui::KeyboardCode>(ui::VKEY_0 + code - '0');
  switch (code) {
    case '\r': case '\n': return ui::VKEY_RETURN;
    case '\b':            return ui::VKEY_BACK;
    case '\t':            return ui::VKEY_TAB;
    case ' ':             return ui::VKEY_SPACE;
    case 0x1B:            return ui::VKEY_ESCAPE;
    // Extended keys.
    case JSOS_KEY_UP:     return ui::VKEY_UP;
    case JSOS_KEY_DOWN:   return ui::VKEY_DOWN;
    case JSOS_KEY_LEFT:   return ui::VKEY_LEFT;
    case JSOS_KEY_RIGHT:  return ui::VKEY_RIGHT;
    case JSOS_KEY_HOME:   return ui::VKEY_HOME;
    case JSOS_KEY_END:    return ui::VKEY_END;
    case JSOS_KEY_PAGEUP: return ui::VKEY_PRIOR;
    case JSOS_KEY_PAGEDOWN: return ui::VKEY_NEXT;
    case JSOS_KEY_DELETE: return ui::VKEY_DELETE;
    case JSOS_KEY_F1:     return ui::VKEY_F1;
    case JSOS_KEY_F2:     return ui::VKEY_F2;
    case JSOS_KEY_F3:     return ui::VKEY_F3;
    case JSOS_KEY_F4:     return ui::VKEY_F4;
    case JSOS_KEY_F5:     return ui::VKEY_F5;
    case JSOS_KEY_F6:     return ui::VKEY_F6;
    case JSOS_KEY_F7:     return ui::VKEY_F7;
    case JSOS_KEY_F8:     return ui::VKEY_F8;
    case JSOS_KEY_F9:     return ui::VKEY_F9;
    case JSOS_KEY_F10:    return ui::VKEY_F10;
    case JSOS_KEY_F11:    return ui::VKEY_F11;
    case JSOS_KEY_F12:    return ui::VKEY_F12;
    default:              return ui::VKEY_UNKNOWN;
  }
}

}  // namespace

JsosEventSource::JsosEventSource()  = default;
JsosEventSource::~JsosEventSource() = default;

void JsosEventSource::Start() {
  running_       = true;
  mouse_x_       = 400;
  mouse_y_       = 300;
}

void JsosEventSource::Stop() {
  running_ = false;
}

// Called from the Chromium message loop on each idle iteration.
// Polls JSOS kernel for pending key/mouse events and dispatches them.
void JsosEventSource::Poll() {
  if (!running_) return;

  // Drain keyboard queue.
  for (int i = 0; i < 16; i++) {
    int code = jsos_read_key();
    if (!code) break;

    // JSOS keyboard buffer only queues key-press events (no key-up).
    // Generate a paired press+release so Chromium's input state stays consistent.
    auto kc = JsosKeyToVKey(code);
    if (kc == ui::VKEY_UNKNOWN) continue;

    ui::KeyEvent press(ui::ET_KEY_PRESSED,  kc, ui::EF_NONE);
    DispatchEventToObservers(&press);
    ui::KeyEvent release(ui::ET_KEY_RELEASED, kc, ui::EF_NONE);
    DispatchEventToObservers(&release);
  }

  // Drain mouse queue.
  for (int i = 0; i < 8; i++) {
    JsosMousePacket pkt = jsos_read_mouse();
    if (!pkt.valid) break;

    mouse_x_ += pkt.dx;
    mouse_y_ += pkt.dy;  // syscall_dispatch already inverts PS/2 y-axis
    if (mouse_x_ < 0)    mouse_x_ = 0;
    if (mouse_y_ < 0)    mouse_y_ = 0;

    gfx::PointF pos(static_cast<float>(mouse_x_),
                    static_cast<float>(mouse_y_));
    ui::MouseEvent event(ui::ET_MOUSE_MOVED, pos, pos,
                         base::TimeTicks::Now(), ui::EF_NONE, 0);
    DispatchEventToObservers(&event);
  }
}

}  // namespace ui
