#ifndef DUKTAPE_BINDING_H
#define DUKTAPE_BINDING_H

int duktape_initialize(void);
int duktape_run_os(void);
void duktape_cleanup(void);

/* Run the interactive event loop (keyboard-driven) */
void duktape_event_loop(void);

#endif
