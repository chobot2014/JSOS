# JSOS Contributing Guide
**Item 890**

Thank you for contributing to JSOS! This guide explains the process.

## Core Principle

> **C code = thin hardware register I/O only. All algorithms, drivers, protocols,
> scheduling, filesystems, and applications = TypeScript.**

If you find yourself writing logic in C, move it to TypeScript.

## Development Setup

```bash
git clone https://github.com/jsos/jsos.git
cd jsos
npm install
```

See [docs/getting-started.md](getting-started.md) for full setup instructions.

## Submitting Changes

1. Fork the repo and create a feature branch: `git checkout -b feat/my-feature`
2. Make changes following the guidelines below
3. Run tests: `node build/js/test/suite.js`
4. Push and open a Pull Request

## Code Style

- **TypeScript**: strict mode (`"strict": true`), explicit return types on public APIs
- **C**: Linux kernel style (4-space indent, no C++ comments in C files)
- **Naming**: `camelCase` for TypeScript, `snake_case` for C
- **Files**: one class/subsystem per file; co-locate types with their implementation
- **Tests**: every public API function needs at least one test in `src/os/test/suite.ts`

## Architecture Rules

1. **No C logic**: scheduling, FS metadata, protocol parsing → TypeScript
2. **No external runtime**: no Node.js, Deno, or browser APIs in kernel code
3. **No non-JS apps**: all applications must be TypeScript — no Lua, Python, etc.
4. **Hardware access only via kernel bindings**: never directly call QuickJS APIs from C
5. **Layered imports**: apps may import from core/subsystems; subsystems may not import from apps

## Adding a New Subsystem

1. Create `src/os/<subsystem>/index.ts` as the public API
2. Add `sys.<subsystem>` to `src/os/core/syscalls.ts`
3. Document it in `docs/sys-api-reference.md`
4. Add at least 3 unit tests to `src/os/test/suite.ts`

## Adding a New Application

1. Create `src/os/apps/<appname>/index.ts` with an exported `main()` function
2. Register in `src/os/ui/commands.ts`
3. Add to README.md application list

## Security Guidelines

- Never expose raw physical addresses or kernel pointers to user applications
- User input to system calls must be sanitised (length, range, type checks)
- New network code must be reviewed for parsing bugs (fuzzing encouraged)

## Testing

```bash
node build/js/test/suite.js       # unit tests (no QEMU)
bash scripts/test.sh              # integration tests (needs QEMU)
```

## License

All contributions are licensed under the project license (see `/LICENSE`).
By contributing, you agree to the Developer Certificate of Origin (DCO).
