FROM ubuntu:22.04

# Install QEMU and testing dependencies
RUN apt-get update && apt-get install -y \
    qemu-system-x86 \
    qemu-utils \
    expect \
    socat \
    netcat-openbsd \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set up working directory
WORKDIR /workspace

# Make scripts executable
COPY scripts/ /workspace/scripts/
RUN chmod +x /workspace/scripts/*.sh

CMD ["./scripts/test.sh"]
