FROM node:18-bullseye AS builder

# Install build dependencies and cross-compiler toolchain
RUN apt-get update && apt-get install -y \
    build-essential \
    nasm \
    xorriso \
    grub-pc-bin \
    grub-common \
    # Item 2: genisoimage/mkisofs for xorriso-free ISO path
    genisoimage \
    # Item 3: UEFI/GPT boot — EFI GRUB modules + ESP tooling
    grub-efi-amd64-bin \
    grub-efi-ia32-bin \
    ovmf \
    dosfstools \
    parted \
    # mtools already present; ensure full suite
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

# QuickJS vendored at src/kernel/vendor/quickjs (upstream commit f1139494, 2025-09-13).
# Pre-patched: bare-metal compat (no atomics, no tm_gmtoff, __asm__) +
#              JSOS_JIT_HOOK support (call_count, jit_native_ptr, JS_SetJITHook).
# Copy it into the expected /opt/quickjs path used by Makefile.
COPY src/kernel/vendor/quickjs /opt/quickjs

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

# Build TypeScript to ES5 JavaScript with modern tooling
RUN npm run build:local

# Build the kernel and create ISO
RUN ./scripts/build.sh

FROM scratch
COPY --from=builder /workspace/build/jsos.iso /jsos.iso
