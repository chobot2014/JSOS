# JSOS `sys.*` TypeScript API Reference
**Item 882** — Complete reference for the OS TypeScript API surface

Every piece of OS functionality is exposed through the `sys` namespace object,
which is accessible from both kernel-level TypeScript and user applications.

---

## `sys.process`

```typescript
sys.process.getpid(): number
sys.process.getppid(): number
sys.process.spawn(command: string, args?: string[]): Promise<Process>
sys.process.kill(pid: number, signal?: number): void
sys.process.wait(pid: number): Promise<{ exitCode: number }>
sys.process.list(): ProcessInfo[]
sys.process.current(): ProcessInfo
```

---

## `sys.fs` — Virtual File System

```typescript
sys.fs.readFile(path: string): Promise<Uint8Array>
sys.fs.writeFile(path: string, data: Uint8Array | string): Promise<void>
sys.fs.appendFile(path: string, data: Uint8Array | string): Promise<void>
sys.fs.readdir(path: string): Promise<string[]>
sys.fs.stat(path: string): Promise<FileStat>
sys.fs.mkdir(path: string, recursive?: boolean): Promise<void>
sys.fs.rm(path: string, recursive?: boolean): Promise<void>
sys.fs.rename(from: string, to: string): Promise<void>
sys.fs.exists(path: string): Promise<boolean>
sys.fs.readText(path: string, encoding?: 'utf8'): Promise<string>
sys.fs.writeText(path: string, data: string): Promise<void>
sys.fs.watch(path: string, cb: (event: string, name: string) => void): Watcher
```

### FileStat

```typescript
interface FileStat {
  size:      number;
  isFile:    boolean;
  isDir:     boolean;
  mtime:     number;   // unix ms
  atime:     number;
  ctime:     number;
  mode:      number;   // unix permission bits
  uid:       number;
  gid:       number;
}
```

---

## `sys.net` — Network Stack

```typescript
sys.net.createSocket(type?: 'tcp' | 'udp'): Socket
sys.net.connect(host: string, port: number): Promise<Socket>
sys.net.listen(port: number, cb: (client: Socket) => void): Server
sys.net.dns.resolve(hostname: string): Promise<string>
sys.net.http.get(url: string, headers?: Record<string, string>): Promise<Response>
sys.net.http.post(url: string, body: string | Uint8Array, headers?: Record<string, string>): Promise<Response>
sys.net.http.fetch(url: string, init?: RequestInit): Promise<Response>
```

### Socket

```typescript
interface Socket {
  write(data: string | Uint8Array): Promise<void>
  read(len?: number): Promise<Uint8Array>
  close(): void
  on(event: 'data' | 'close' | 'error', cb: (data?: any) => void): void
  setEncoding(enc: 'utf8' | 'binary'): void
}
```

---

## `sys.audio` — Audio Subsystem

```typescript
sys.audio.init(sampleRate?: number): void
sys.audio.loadDecoded(format: 'mp3' | 'ogg' | 'aac' | 'flac' | 'pcm', data: Uint8Array): AudioSource
sys.audio.createSource(pcm: Int16Array, opts?: AudioSourceOpts): AudioSource
sys.audio.destroySource(src: AudioSource): void
sys.audio.play(src: AudioSource): void
sys.audio.pause(src: AudioSource): void
sys.audio.stop(src: AudioSource): void
sys.audio.seek(src: AudioSource, seconds: number): void
sys.audio.setVolume(src: AudioSource, vol: number): void     // 0..1
sys.audio.setPan(src: AudioSource, pan: number): void        // -1..1
sys.audio.setMasterVolume(vol: number): void
sys.audio.setBass(gain_dB: number): void
sys.audio.setTreble(gain_dB: number): void
```

---

## `sys.vmm` — Virtual Memory Manager

```typescript
sys.vmm.alloc(size: number): VirtualRegion
sys.vmm.free(region: VirtualRegion): void
sys.vmm.mapFile(path: string, offset: number, length: number, flags: MMapFlags): VirtualRegion
sys.vmm.protect(region: VirtualRegion, prot: Protection): void
sys.vmm.query(addr: number): VirtualRegion | null
```

---

## `sys.ipc` — Inter-Process Communication

```typescript
sys.ipc.createPipe(): [ReadableStream, WritableStream]
sys.ipc.createChannel(name: string): Channel
sys.ipc.openChannel(name: string): Channel
sys.ipc.send(channel: Channel, msg: unknown): void
sys.ipc.recv(channel: Channel): Promise<unknown>
```

---

## `sys.storage` — Block Storage

```typescript
sys.storage.list(): StorageDevice[]
sys.storage.open(device: string): BlockDevice
```

---

## `sys.users` — User Management

```typescript
sys.users.current(): User
sys.users.list(): User[]
sys.users.add(name: string, password: string, groups?: string[]): Promise<void>
sys.users.remove(name: string): Promise<void>
sys.users.authenticate(name: string, password: string): Promise<boolean>
sys.users.setPassword(name: string, password: string): Promise<void>
```

---

## `sys.env` — Environment Variables

```typescript
sys.env.get(name: string): string | undefined
sys.env.set(name: string, value: string): void
sys.env.delete(name: string): void
sys.env.all(): Record<string, string>
```

---

## `sys.time` — Clocks

```typescript
sys.time.now(): number          // unix ms
sys.time.monotonic(): number    // ms since boot (no leap second)
sys.time.tsCounter(): bigint    // raw TSC value
```

---

## `sys.display` — Framebuffer Output

```typescript
sys.display.width: number
sys.display.height: number
sys.display.blit(x: number, y: number, w: number, h: number, pixels: Uint32Array): void
sys.display.clear(color?: number): void
sys.display.requestAnimationFrame(cb: (timestamp: number) => void): number
```

---

## `sys.debug` — Debugging

```typescript
sys.debug.log(msg: string): void         // to COM1
sys.debug.panic(msg: string): never      // kernel panic
sys.debug.assert(cond: boolean, msg?: string): void
sys.debug.breakpoint(): void             // software breakpoint (int3)
sys.debug.dumpHeap(): HeapStats
```

---

*Generated from TypeScript source in `src/os/`. See `src/os/core/` for runtime entry points.*
