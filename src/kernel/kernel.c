#include <stddef.h>
#include <stdint.h>
#include "platform.h"
#include "memory.h"
#include "irq.h"
#include "keyboard.h"
#include "mouse.h"
#include "timer.h"
#include "cpuid.h"
#include "cmdline.h"
#include "acpi.h"
#include "quickjs_binding.h"
#include "secboot.h"   /* item 13 */
#include "pxe.h"       /* item 17 */

#if !defined(__i386__)
#error "This kernel needs to be compiled with a ix86-elf compiler"
#endif

extern void gdt_flush(void);
extern uint32_t _multiboot2_ptr;   /* set by boot.s before calling _start */

int main(void) {
    platform_init();
    platform_boot_print("JSOS booting...\n");
    platform_boot_print("JSOS Kernel v1.0.0\n==================\n\n");

    /* ── CPUID feature detection (item 8) ──────────────────────────────── */
    cpuid_detect();
    platform_boot_print("[BOOT] CPUID: vendor=");
    platform_boot_print(cpuid_features.vendor);
    platform_boot_print(cpuid_features.sse2 ? " SSE2=1" : " SSE2=0");
    platform_boot_print(cpuid_features.nx   ? " NX=1\n" : " NX=0\n");

    /* ── Kernel command-line (item 4) ───────────────────────────────────── */
    cmdline_parse(_multiboot2_ptr);

    /* ── Boot splash (item 14) ─────────────────────────────────────────── */
    platform_boot_splash();

    /* ── Secure Boot detection (item 13) ───────────────────────────────── */
    secboot_init(_multiboot2_ptr);
    if (cmdline_raw()[0]) {
        platform_boot_print("[BOOT] cmdline: ");
        platform_boot_print(cmdline_raw());
        platform_boot_print("\n");
    }

    /* ── Physical memory (items 10, 12) ──────────────────────────────────── */
    platform_boot_print("[BOOT] Initializing memory (E820 + EFI mmap)...\n");
    memory_init_from_mb2(_multiboot2_ptr);

    /* ── PXE / netboot detection (item 17) ──────────────────────────────── */
    pxe_init(_multiboot2_ptr);

    platform_boot_print("[BOOT] Loading GDT...\n");
    gdt_flush();

    /* Phase 9: install user-mode GDT entries + TSS so ring-3 exec works */
    platform_tss_init();
    platform_gdt_install_tss();
    platform_boot_print("[BOOT] TSS installed (ring-3 exec ready)\n");

    platform_boot_print("[BOOT] Initializing interrupts...\n");
    irq_initialize();

    platform_boot_print("[BOOT] Initializing timer (1000 Hz = 1ms ticks)...\n");
    timer_initialize(1000);

    /* ── TSC calibration (item 46) ──────────────────────────────────────── */
    timer_calibrate_tsc();
    {
        uint32_t hz = timer_tsc_hz();
        /* Quick serial print of MHz approximation */
        char buf[32];
        uint32_t mhz = hz / 1000000u;
        buf[0] = '['; buf[1] = 'B'; buf[2] = 'O'; buf[3] = 'O'; buf[4] = 'T';
        buf[5] = ']'; buf[6] = ' '; buf[7] = 'T'; buf[8] = 'S'; buf[9] = 'C';
        buf[10]= ' '; int n=11;
        if (mhz == 0) { buf[n++]='?'; } else {
            uint32_t tmp=mhz; int len=0; char t[8];
            while(tmp){ t[len++]=(char)('0'+tmp%10); tmp/=10; }
            for(int i=len-1;i>=0;i--) buf[n++]=t[i];
        }
        buf[n++]=' '; buf[n++]='M'; buf[n++]='H'; buf[n++]='z'; buf[n++]='\n'; buf[n]=0;
        platform_boot_print(buf);
    }

    platform_boot_print("[BOOT] Initializing keyboard...\n");
    keyboard_initialize();

    platform_boot_print("[BOOT] Initializing mouse...\n");
    mouse_initialize();

    /* ── ACPI init (item 11) ────────────────────────────────────────────── */
    platform_boot_print("[BOOT] Initializing ACPI...\n");
    acpi_init(_multiboot2_ptr);

    /* Parse multiboot2 info for framebuffer address before QuickJS starts */
    platform_fb_init(_multiboot2_ptr);

    /* MTRR write-combine for framebuffer if available (item 67) */
    if (cpuid_features.mtrr) {
        fb_info_t fb_inf;
        platform_fb_get_info(&fb_inf);
        if (fb_inf.available && fb_inf.address) {
            /* size = pitch * height (bytes), rounded up to power-of-two by driver */
            uint32_t fb_size = fb_inf.pitch * fb_inf.height;
            platform_mtrr_set_wc((uint32_t)fb_inf.address, fb_size);
        }
    }

    platform_boot_print("[BOOT] Initializing QuickJS runtime (ES2023)...\n");
    if (quickjs_initialize() != 0) {
        platform_boot_print("FATAL: Failed to initialize JavaScript runtime\n");
        __asm__ volatile ("cli; hlt");
        return 1;
    }
    platform_boot_print("[BOOT] QuickJS runtime ready\n");

    platform_boot_print("[BOOT] Loading JavaScript OS...\n\n");
    if (quickjs_run_os() != 0) {
        platform_boot_print("FATAL: Failed to run JavaScript OS\n");
        __asm__ volatile ("cli; hlt");
        return 1;
    }

    platform_boot_print("\nSystem halted.\n");
    __asm__ volatile ("cli; hlt");
    return 0;
}
