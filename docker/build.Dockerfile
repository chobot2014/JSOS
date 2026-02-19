FROM node:18-bullseye AS builder

# Install build dependencies and cross-compiler toolchain
RUN apt-get update && apt-get install -y \
    build-essential \
    nasm \
    xorriso \
    grub-pc-bin \
    grub-common \
    mtools \
    wget \
    curl \
    git \
    bison \
    flex \
    libgmp3-dev \
    libmpc-dev \
    libmpfr-dev \
    texinfo \
    libisl-dev \
    && rm -rf /var/lib/apt/lists/*

# Build i686-elf cross-compiler with newlib from source
WORKDIR /tmp
RUN wget https://ftp.gnu.org/gnu/binutils/binutils-2.41.tar.xz && \
    wget https://ftp.gnu.org/gnu/gcc/gcc-13.2.0/gcc-13.2.0.tar.xz && \
    wget ftp://sourceware.org/pub/newlib/newlib-4.3.0.20230120.tar.gz && \
    tar -xf binutils-2.41.tar.xz && \
    tar -xf gcc-13.2.0.tar.xz && \
    tar -xf newlib-4.3.0.20230120.tar.gz

# Build binutils
RUN mkdir -p build-binutils && cd build-binutils && \
    ../binutils-2.41/configure --target=i686-elf --prefix=/opt/cross --with-sysroot --disable-nls --disable-werror && \
    make -j$(nproc) && make install

ENV PATH="/opt/cross/bin:${PATH}"

# Build GCC (bootstrap)
RUN mkdir -p build-gcc && cd build-gcc && \
    ../gcc-13.2.0/configure --target=i686-elf --prefix=/opt/cross --disable-nls --enable-languages=c,c++ --without-headers && \
    make -j$(nproc) all-gcc && make -j$(nproc) all-target-libgcc && \
    make install-gcc && make install-target-libgcc

# Build newlib
RUN mkdir -p build-newlib && cd build-newlib && \
    ../newlib-4.3.0.20230120/configure --target=i686-elf --prefix=/opt/cross && \
    make -j$(nproc) all && make install

# Rebuild GCC with newlib
RUN cd build-gcc && \
    make -j$(nproc) all && make install

# Clean up
RUN rm -rf /tmp/*

# Download QuickJS source from official GitHub repo
WORKDIR /opt
RUN git clone --depth 1 https://github.com/bellard/quickjs.git quickjs

# Patch QuickJS for bare-metal cross-compilation (no pthreads, no atomics)
RUN cd quickjs && \
    # Disable CONFIG_ATOMICS (requires pthread) as recommended by QuickJS docs
    sed -i 's/^#define CONFIG_ATOMICS/\/\/ #define CONFIG_ATOMICS  \/\* disabled for bare-metal *\//' quickjs.c && \
    # Fix tm_gmtoff - newlib doesn't have this GNU extension (use dot accessor)
    sed -i 's/tm\.tm_gmtoff/0 \/\* tm_gmtoff unavailable \*\//' quickjs.c && \
    # Fix C11 asm keyword - use __asm__ instead
    sed -i 's/\basm volatile\b/__asm__ volatile/g; s/\basm(\b/__asm__(/g' quickjs.c

# Set up working directory for our project
WORKDIR /workspace

# Copy package files first for better caching
COPY package*.json ./
RUN npm ci

# Copy source code and scripts
COPY . .

# Fix line endings (Windows → Unix) and make scripts executable
RUN find . -name "*.sh" -exec sed -i 's/\r$//' {} + && \
    chmod +x scripts/*.sh

# Install dosfstools for FAT16 disk image creation (kept separate for cache)
RUN apt-get update && apt-get install -y dosfstools && rm -rf /var/lib/apt/lists/*

# Build TypeScript to ES5 JavaScript with modern tooling
RUN npm run build:local

# Build the kernel and create ISO
RUN ./scripts/build.sh

# Create a 64 MiB FAT16 disk image for persistent storage
RUN dd if=/dev/zero of=/workspace/build/disk.img bs=1M count=64 && \
    mkfs.fat -F 16 -n "JSDISK" /workspace/build/disk.img

FROM scratch
COPY --from=builder /workspace/build/jsos.iso /jsos.iso
COPY --from=builder /workspace/build/disk.img /disk.img
