CC = i686-elf-gcc
CFLAGS = -ffreestanding -O2 -Wall -Wextra -std=c11 -DCONFIG_VERSION=\"2025.09\" -Dalloca=__builtin_alloca
LDFLAGS = -ffreestanding -O2 -nostartfiles -lgcc -lc -lnosys -lm
QUICKJS_DIR = /opt/quickjs

# QuickJS source files (compiled separately for different warning settings)
QJS_SOURCES = $(QUICKJS_DIR)/quickjs.c $(QUICKJS_DIR)/libregexp.c \
              $(QUICKJS_DIR)/libunicode.c $(QUICKJS_DIR)/cutils.c \
              $(QUICKJS_DIR)/dtoa.c

SOURCES = boot.s crt0.s irq_asm.s kernel.c quickjs_binding.c platform.c memory.c \
          syscalls.c math_impl.c irq.c keyboard.c mouse.c timer.c ata.c \
          pci.c virtio_net.c jit.c
OBJECTS = $(SOURCES:.s=.o)
OBJECTS := $(OBJECTS:.c=.o)

# QuickJS objects (compiled with relaxed warnings)
QJS_OBJECTS = $(notdir $(QJS_SOURCES:.c=.o))

TARGET = jsos.bin

.PHONY: all clean

all: $(TARGET)

# Link everything together
$(TARGET): $(OBJECTS) $(QJS_OBJECTS)
	$(CC) -T linker.ld -o $@ $(LDFLAGS) $^

# Compile our kernel sources
%.o: %.c
	$(CC) $(CFLAGS) -I$(QUICKJS_DIR) -c $< -o $@

# Compile QuickJS sources with relaxed warnings and bare-metal compat flags
# PRId64/PRIu64 must be defined manually since -ffreestanding + newlib doesn't
# properly expose inttypes.h format macros
$(QJS_OBJECTS): $(QJS_SOURCES)
	$(CC) -ffreestanding -O2 -std=c11 -DCONFIG_VERSION=\"2025.09\" \
	  -D_GNU_SOURCE -fwrapv -Dasm=__asm__ -Dalloca=__builtin_alloca \
	  -D'PRId64="lld"' -D'PRIi64="lli"' -D'PRIu64="llu"' -D'PRIx64="llx"' \
	  -w -I$(QUICKJS_DIR) -c $(QUICKJS_DIR)/$(patsubst %.o,%.c,$@) -o $@

%.o: %.s
	nasm -felf32 $< -o $@

clean:
	rm -f $(OBJECTS) $(QJS_OBJECTS) $(TARGET)

.DEFAULT_GOAL := all
