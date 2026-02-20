// Copyright 2024 The JSOS Authors. All rights reserved.
#ifndef UI_OZONE_PLATFORM_JSOS_JSOS_EVENT_SOURCE_H_
#define UI_OZONE_PLATFORM_JSOS_JSOS_EVENT_SOURCE_H_

namespace ui {

// Polls the JSOS kernel (via custom int 0x80 syscalls) for keyboard and
// mouse events and delivers them to Chromium's platform event dispatcher.
// This is called from the Chromium message loop on each idle cycle.
class JsosEventSource {
 public:
  JsosEventSource();
  ~JsosEventSource();

  // Begin polling.
  void Start();

  // Stop polling (called on shutdown).
  void Stop();

  // Drain pending events; call from the Chromium run loop.
  void Poll();

 private:
  bool running_ = false;
  int  mouse_x_ = 0;
  int  mouse_y_ = 0;
};

}  // namespace ui

#endif  // UI_OZONE_PLATFORM_JSOS_JSOS_EVENT_SOURCE_H_
