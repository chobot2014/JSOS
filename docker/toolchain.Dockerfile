FROM node:18-bullseye

# Install build dependencies and cross-compiler toolchain
RUN apt-get update && apt-get install -y \
    build-essential \
    nasm \
    xorriso \
    grub-pc-bin \
    grub-common \
    genisoimage \
    grub-efi-amd64-bin \
    grub-efi-ia32-bin \
    ovmf \
    dosfstools \
    parted \
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

# Build i686-elf cross-compiler with newlib from source.
# This layer is expensive (~10-15 min) but is cached permanently once built.
WORKDIR /tmp
RUN wget https://ftp.gnu.org/gnu/binutils/binutils-2.41.tar.xz && \
    wget https://ftp.gnu.org/gnu/gcc/gcc-13.2.0/gcc-13.2.0.tar.xz && \
    wget ftp://sourceware.org/pub/newlib/newlib-4.3.0.20230120.tar.gz && \
    tar -xf binutils-2.41.tar.xz && \
    tar -xf gcc-13.2.0.tar.xz && \
    tar -xf newlib-4.3.0.20230120.tar.gz

RUN mkdir -p build-binutils && cd build-binutils && \
    ../binutils-2.41/configure --target=i686-elf --prefix=/opt/cross --with-sysroot --disable-nls --disable-werror && \
    make -j$(nproc) && make install

ENV PATH="/opt/cross/bin:${PATH}"

RUN mkdir -p build-gcc && cd build-gcc && \
    ../gcc-13.2.0/configure --target=i686-elf --prefix=/opt/cross --disable-nls --enable-languages=c,c++ --without-headers && \
    make -j$(nproc) all-gcc && make -j$(nproc) all-target-libgcc && \
    make install-gcc && make install-target-libgcc

RUN mkdir -p build-newlib && cd build-newlib && \
    ../newlib-4.3.0.20230120/configure --target=i686-elf --prefix=/opt/cross && \
    make -j$(nproc) all && make install

RUN cd build-gcc && \
    make -j$(nproc) all && make install

# Clean up downloaded sources
RUN rm -rf /tmp/*

# QuickJS vendored source — copy into expected location.
# Rebuild toolchain image (npm run build:toolchain) only when this changes.
COPY src/kernel/vendor/quickjs /opt/quickjs

WORKDIR /workspace
