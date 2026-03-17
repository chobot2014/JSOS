/*
 * gamepad.c — Gamepad and touch input stubs (items 63, 64)
 */
#include "gamepad.h"
#include "platform.h"

static int _gamepad_count = 0;
static int _touch_present_flag = 0;

int gamepad_init(void) {
    platform_boot_print("[GAMEPAD] Stub: USB gamepad polling not yet implemented\n");
    _gamepad_count = 0;
    return 0;
}

int gamepad_present(uint8_t index) { (void)index; return 0; }

int gamepad_read(uint8_t index, gamepad_state_t *state) {
    if (!state || index >= (uint8_t)_gamepad_count) return -1;
    /* Return zeroed state for disconnected pad */
    state->buttons = 0; state->lx = 0; state->ly = 0;
    state->rx = 0;      state->ry = 0;
    state->lt = 0;      state->rt = 0;
    return 0;
}

int gamepad_rumble(uint8_t index, uint8_t low_hz, uint8_t high_hz, uint16_t ms) {
    (void)index; (void)low_hz; (void)high_hz; (void)ms;
    return -1;  /* No FFB hardware */
}

int touch_init(void) {
    platform_boot_print("[TOUCH] Stub: no touch device detected\n");
    _touch_present_flag = 0;
    return 0;
}

int touch_present(void) { return _touch_present_flag; }

int touch_read(touch_point_t *points, int max_points) {
    (void)points; (void)max_points;
    return 0;  /* No active touch contacts */
}
