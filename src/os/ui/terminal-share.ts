/**
 * Terminal Session Sharing over Network
 * Item 686 — share a live REPL/terminal session with another user over TCP
 *
 * Server side: binds a port, streams terminal bytes to connected peers.
 * Client side: connects to a server, renders incoming bytes locally.
 *
 * Architecture:
 *   TerminalShareServer  — wraps a terminal and broadcasts I/O to all clients
 *   TerminalShareClient  — connects to a server, pipe remote → local terminal
 *
 * Protocol: raw byte stream over TCP (like `tty share`).
 * Each "packet" is:
 *   [1 byte type][3 bytes length][<length> bytes payload]
 * Types:
 *   0x01 = terminal data (UTF-8 bytes)
 *   0x02 = resize (4 bytes: uint16 cols, uint16 rows)
 *   0x03 = heartbeat (empty payload)
 */

declare const sys: any;

const PKT_DATA      = 0x01;
const PKT_RESIZE    = 0x02;
const PKT_HEARTBEAT = 0x03;

// ── helpers ────────────────────────────────────────────────────────────────

function encodePacket(type: number, payload: Uint8Array): Uint8Array {
  const len = payload.length;
  const out = new Uint8Array(4 + len);
  out[0] = type;
  out[1] = (len >> 16) & 0xff;
  out[2] = (len >>  8) & 0xff;
  out[3] =  len        & 0xff;
  out.set(payload, 4);
  return out;
}

function decodeLength(header: Uint8Array): number {
  return (header[1] << 16) | (header[2] << 8) | header[3];
}

// ── server ─────────────────────────────────────────────────────────────────

export interface TerminalShareServer {
  port: number;
  clientCount: number;
  stop(): void;
}

/**
 * Start sharing the given terminal on `port` (default 2222).
 * Any TCP client that connects will receive a live stream of terminal output.
 * If `readOnly` is false, clients can also send keystrokes to the terminal.
 */
export function shareTerminal(
  terminal: { onData(cb: (data: Uint8Array) => void): void; write(data: Uint8Array): void;
               cols: number; rows: number },
  port = 2222,
  readOnly = true,
): TerminalShareServer {
  const clients: Array<{ socket: any; active: boolean }> = [];
  const serverSocket = sys.net.createSocket();
  serverSocket.bind(port);
  serverSocket.listen();

  let running = true;

  // Broadcast terminal output to all peers
  terminal.onData((data: Uint8Array) => {
    const pkt = encodePacket(PKT_DATA, data);
    for (const c of clients) {
      if (c.active) {
        try { c.socket.write(pkt); } catch { c.active = false; }
      }
    }
  });

  // Accept loop
  function acceptLoop() {
    if (!running) return;
    try {
      const clientSocket = serverSocket.accept();
      const client = { socket: clientSocket, active: true };
      clients.push(client);

      // Send current size
      const resizePkt = new Uint8Array(4);
      const dv = new DataView(resizePkt.buffer);
      dv.setUint16(0, terminal.cols);
      dv.setUint16(2, terminal.rows);
      clientSocket.write(encodePacket(PKT_RESIZE, resizePkt));

      if (!readOnly) {
        // Read keystrokes from client
        function readClient() {
          try {
            const header = clientSocket.read(4);
            if (!header || header.length < 4) { client.active = false; return; }
            const payloadLen = decodeLength(header);
            const payload = payloadLen > 0 ? clientSocket.read(payloadLen) : new Uint8Array(0);
            if (header[0] === PKT_DATA) terminal.write(payload);
            readClient();
          } catch { client.active = false; }
        }
        readClient();
      }
    } catch { /* accept error, loop continues */ }
    sys.process.nextTick(acceptLoop);
  }

  acceptLoop();

  const server: TerminalShareServer = {
    port,
    get clientCount() { return clients.filter(c => c.active).length; },
    stop() {
      running = false;
      serverSocket.close();
      for (const c of clients) { try { c.socket.close(); } catch {} c.active = false; }
    },
  };

  return server;
}

// ── client ─────────────────────────────────────────────────────────────────

export interface TerminalShareClient {
  disconnect(): void;
}

/**
 * Connect to a running TerminalShareServer.
 * Terminal data is passed to `onData`; resize events fire `onResize`.
 */
export function connectToSharedTerminal(
  host: string,
  port = 2222,
  opts: {
    onData(data: Uint8Array): void;
    onResize?(cols: number, rows: number): void;
    onDisconnect?(): void;
    sendKeystrokes?: boolean;
    keystrokeSource?: { onKey(cb: (key: Uint8Array) => void): void };
  },
): TerminalShareClient {
  const socket = sys.net.createSocket();
  socket.connect(host, port);
  let connected = true;

  function readLoop() {
    try {
      const header = socket.read(4);
      if (!header || header.length < 4) { connected = false; opts.onDisconnect?.(); return; }
      const payloadLen = decodeLength(header);
      const payload = payloadLen > 0 ? socket.read(payloadLen) : new Uint8Array(0);
      switch (header[0]) {
        case PKT_DATA:    opts.onData(payload); break;
        case PKT_RESIZE:  if (opts.onResize) {
                            const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
                            opts.onResize(dv.getUint16(0), dv.getUint16(2));
                          }
                          break;
        case PKT_HEARTBEAT: break;
      }
      readLoop();
    } catch { connected = false; opts.onDisconnect?.(); }
  }

  readLoop();

  if (opts.sendKeystrokes && opts.keystrokeSource) {
    opts.keystrokeSource.onKey((key: Uint8Array) => {
      if (connected) try { socket.write(encodePacket(PKT_DATA, key)); } catch { connected = false; }
    });
  }

  return {
    disconnect() { connected = false; try { socket.close(); } catch {} opts.onDisconnect?.(); },
  };
}
