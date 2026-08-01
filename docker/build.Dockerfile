# Fast build — inherits the pre-built cross-compiler from jsos-toolchain.
# Only source files, npm deps, and the kernel compile re-run here (~30-60 s).
#
# Workflow:
#   npm run build:toolchain   — build toolchain image once (~10-15 min first time only)
#   npm run build             — fast incremental build every iteration (~30-60 s)
#   npm run build:full        — force full rebuild from scratch (equivalent to old behaviour)

FROM jsos-toolchain AS builder

ENV PATH="/opt/cross/bin:${PATH}"

# npm dependencies — layer is cached until package.json changes
WORKDIR /workspace
COPY package*.json ./
RUN npm ci

# Source code — invalidated on any source change, but only this layer + below re-run
COPY . .

# Fix line endings (Windows → Unix) and make scripts executable
RUN find . -name "*.sh" -exec sed -i 's/\r$//' {} + && \
    chmod +x scripts/*.sh

# Bundle TypeScript → embed into embedded_js.h → compile C kernel → create ISO
RUN npm run build:local
RUN ./scripts/build.sh

FROM scratch
COPY --from=builder /workspace/build/jsos.iso /jsos.iso
