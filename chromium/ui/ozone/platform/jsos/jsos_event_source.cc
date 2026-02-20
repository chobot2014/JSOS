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

// Minimal PS/2 scan-code to Chromium KeyboardCode mapping.
static ui::KeyboardCode ScanCodeToKeyCode(int scancode) {
  if (scancode >= 0x02 && scancode <= 0x0B)
    return static_cast<ui::KeyboardCode>(ui::VKEY_1 + scancode - 0x02);
  if (scancode >= 0x10 && scancode <= 0x19)
    return static_cast<ui::KeyboardCode>(ui::VKEY_Q + scancode - 0x10);
  if (scancode >= 0x1E && scancode <= 0x26)
    return static_cast<ui::KeyboardCode>(ui::VKEY_A + scancode - 0x1E);
  if (scancode >= 0x2C && scancode <= 0x32)
    return static_cast<ui::KeyboardCode>(ui::VKEY_Z + scancode - 0x2C);
  switch (scancode) {
    case 0x01: return ui::VKEY_ESCAPE;
    case 0x0E: return ui::VKEY_BACK;
    case 0x0F: return ui::VKEY_TAB;
    case 0x1C: return ui::VKEY_RETURN;
    case 0x1D: return ui::VKEY_CONTROL;
    case 0x2A: return ui::VKEY_SHIFT;
    case 0x36: return ui::VKEY_SHIFT;
    case 0x38: return ui::VKEY_MENU;
    case 0x39: return ui::VKEY_SPACE;
    case 0x3B: return ui::VKEY_F1;
    case 0x3C: return ui::VKEY_F2;
    case 0x3D: return ui::VKEY_F3;
    case 0x3E: return ui::VKEY_F4;
    case 0x3F: return ui::VKEY_F5;
    case 0x40: return ui::VKEY_F6;
    case 0x41: return ui::VKEY_F7;
    case 0x42: return ui::VKEY_F8;
    case 0x43: return ui::VKEY_F9;
    case 0x44: return ui::VKEY_F10;
    default:   return ui::VKEY_UNKNOWN;
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
    int sc = jsos_read_key();
    if (!sc) break;

    bool key_up   = (sc & 0x80) != 0;
    int  raw_sc   = sc & 0x7F;
    auto kc       = ScanCodeToKeyCode(raw_sc);

    ui::KeyEvent event(
        key_up ? ui::ET_KEY_RELEASED : ui::ET_KEY_PRESSED,
        kc, ui::EF_NONE);
    DispatchEventToObservers(&event);
  }

  // Drain mouse queue.
  for (int i = 0; i < 8; i++) {
    JsosMousePacket pkt = jsos_read_mouse();
    if (!pkt.valid) break;

    mouse_x_ += pkt.dx;
    mouse_y_ -= pkt.dy;  // PS/2: positive dy = up → screen: y decreases
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
