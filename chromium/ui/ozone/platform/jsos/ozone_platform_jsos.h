// Copyright 2024 The JSOS Authors. All rights reserved.
#ifndef UI_OZONE_PLATFORM_JSOS_OZONE_PLATFORM_JSOS_H_
#define UI_OZONE_PLATFORM_JSOS_OZONE_PLATFORM_JSOS_H_

namespace ui {

class OzonePlatform;

// Factory function registered via OZONE_PLATFORM_IMPL for --ozone-platform=jsos.
OzonePlatform* CreateOzonePlatformJsos();

}  // namespace ui

#endif  // UI_OZONE_PLATFORM_JSOS_OZONE_PLATFORM_JSOS_H_
