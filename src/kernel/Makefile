CC = i686-elf-gcc
CFLAGS = -ffreestanding -O2 -Wall -Wextra -std=c99
LDFLAGS = -ffreestanding -O2 -nostartfiles -lgcc -lc -lnosys
DUKTAPE_DIR = /opt/duktape

SOURCES = boot.s crt0.s kernel.c duktape_binding.c terminal.c memory.c syscalls.c math_impl.c
OBJECTS = $(SOURCES:.s=.o)
OBJECTS := $(OBJECTS:.c=.o)

TARGET = jsos.bin

.PHONY: all clean

all: $(TARGET)

$(TARGET): $(OBJECTS)
	$(CC) -T linker.ld -o $@ $(LDFLAGS) $^ $(DUKTAPE_DIR)/src/duktape.c

%.o: %.c
	$(CC) $(CFLAGS) -I$(DUKTAPE_DIR)/src -c $< -o $@

%.o: %.s
	nasm -felf32 $< -o $@

clean:
	rm -f $(OBJECTS) $(TARGET)

.DEFAULT_GOAL := all
