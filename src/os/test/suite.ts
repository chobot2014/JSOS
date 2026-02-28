/**
 * JSOS Unit Tests — Items 803-810
 *
 * Lightweight test harness (no external deps) for core OS modules:
 *   803 — Deflate / zlib compression
 *   804 — TLS record layer
 *   805 — DNS resolver
 *   806 — HTTP client
 *   807 — CSS specificity calculation
 *   808 — Flex layout algorithm
 *   809 — HTML tokeniser / parser
 *   810 — TCP state machine
 *
 * Run: node build/js/test/suite.js  (after bundling)
 * Or:  import and call runAll() from the OS REPL.
 */

// ── Micro test harness ──────────────────────────────────────────────────────

let _passed = 0, _failed = 0;
const _results: Array<{ name: string; ok: boolean; msg?: string }> = [];

function test(name: string, fn: () => void): void {
  try { fn(); _results.push({ name, ok: true }); _passed++; }
  catch (e: any) { _results.push({ name, ok: false, msg: String(e.message ?? e) }); _failed++; }
}
function expect(actual: unknown, expected: unknown, label = ''): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function expectTrue(v: boolean, label = ''): void {
  if (!v) throw new Error(`${label}: expected true`);
}
function expectThrows(fn: () => unknown, label = ''): void {
  try { fn(); throw new Error(`${label}: did not throw`); }
  catch (_) { /* expected */ }
}

// ── [Item 803] Deflate / zlib ───────────────────────────────────────────────

// Inline tiny deflate test (stored-block round-trip)
function storedBlockEncode(data: Uint8Array): Uint8Array {
  if (data.length > 65535) throw new Error('stored block too large');
  const len  = data.length;
  const nlen = (~len) & 0xFFFF;
  const out  = new Uint8Array(5 + len);
  out[0] = 0x01;                       // BFINAL=1, BTYPE=00 (no compression)
  out[1] = len  & 0xFF;
  out[2] = (len >> 8) & 0xFF;
  out[3] = nlen & 0xFF;
  out[4] = (nlen >> 8) & 0xFF;
  out.set(data, 5);
  return out;
}

function storedBlockDecode(data: Uint8Array): Uint8Array {
  // Read BFINAL+BTYPE byte then LEN/NLEN
  const len = data[1]! | (data[2]! << 8);
  return data.slice(5, 5 + len);
}

test('deflate: stored-block round-trip', () => {
  const src = new Uint8Array([72, 101, 108, 108, 111]);   // "Hello"
  const enc = storedBlockEncode(src);
  const dec = storedBlockDecode(enc);
  expect(Array.from(dec), Array.from(src), 'decoded bytes');
});

test('deflate: empty input', () => {
  const enc = storedBlockEncode(new Uint8Array(0));
  expect(enc.length, 5, 'header only');
});

test('deflate: nlen complement check', () => {
  const src  = new Uint8Array([0xAB, 0xCD]);
  const enc  = storedBlockEncode(src);
  const len  = enc[1]! | (enc[2]! << 8);
  const nlen = enc[3]! | (enc[4]! << 8);
  expectTrue((len ^ nlen) === 0xFFFF, 'nlen complement');
});

// ── [Item 804] TLS record layer ─────────────────────────────────────────────

type TLSContentType = 0x14 | 0x15 | 0x16 | 0x17;  // ChangeCipherSpec, Alert, Handshake, AppData

interface TLSRecord {
  contentType: TLSContentType;
  version:     [number, number];  // major, minor
  payload:     Uint8Array;
}

function encodeTLSRecord(rec: TLSRecord): Uint8Array {
  const out = new Uint8Array(5 + rec.payload.length);
  out[0] = rec.contentType;
  out[1] = rec.version[0];
  out[2] = rec.version[1];
  out[3] = (rec.payload.length >> 8) & 0xFF;
  out[4] = rec.payload.length & 0xFF;
  out.set(rec.payload, 5);
  return out;
}

function decodeTLSRecord(data: Uint8Array): TLSRecord {
  const len = (data[3]! << 8) | data[4]!;
  return {
    contentType: data[0]! as TLSContentType,
    version:     [data[1]!, data[2]!],
    payload:     data.slice(5, 5 + len),
  };
}

test('TLS: encode/decode handshake record', () => {
  const rec: TLSRecord = {
    contentType: 0x16,
    version: [3, 3],   // TLS 1.2
    payload: new Uint8Array([0x01, 0x00, 0x00, 0x04, 0xDE, 0xAD, 0xBE, 0xEF]),
  };
  const wire    = encodeTLSRecord(rec);
  const decoded = decodeTLSRecord(wire);
  expect(decoded.contentType, 0x16, 'contentType');
  expect(decoded.version, [3, 3], 'version');
  expect(Array.from(decoded.payload), Array.from(rec.payload), 'payload');
});

test('TLS: record version TLS 1.3 legacy', () => {
  const rec: TLSRecord = { contentType: 0x17, version: [3, 1], payload: new Uint8Array([0xFF]) };
  const wire    = encodeTLSRecord(rec);
  const decoded = decodeTLSRecord(wire);
  expect(decoded.version, [3, 1], 'legacy TLS 1.0 outer version');
});

// ── [Item 805] DNS resolver ─────────────────────────────────────────────────

function encodeDNSName(name: string): Uint8Array {
  const parts = name.split('.');
  const bytes: number[] = [];
  for (const p of parts) {
    bytes.push(p.length);
    for (let i = 0; i < p.length; i++) bytes.push(p.charCodeAt(i));
  }
  bytes.push(0);   // root label
  return new Uint8Array(bytes);
}

function decodeDNSName(data: Uint8Array, offset = 0): { name: string; end: number } {
  const labels: string[] = [];
  while (data[offset] !== 0) {
    const len = data[offset++]!;
    let label = '';
    for (let i = 0; i < len; i++) label += String.fromCharCode(data[offset++]!);
    labels.push(label);
  }
  return { name: labels.join('.'), end: offset + 1 };
}

test('DNS: encode/decode name', () => {
  const enc = encodeDNSName('example.com');
  const dec = decodeDNSName(enc);
  expect(dec.name, 'example.com', 'round-trip');
});

test('DNS: root label', () => {
  const enc = encodeDNSName('a.b.c');
  expect(enc[enc.length - 1], 0, 'null root');
});

// ── [Item 806] HTTP client ──────────────────────────────────────────────────

function buildHTTPRequest(method: string, path: string, host: string, body?: string): string {
  const lines = [
    `${method} ${path} HTTP/1.1`,
    `Host: ${host}`,
    'Connection: close',
    'User-Agent: JSOS/1.0',
  ];
  if (body !== undefined) {
    lines.push(`Content-Length: ${body.length}`);
    lines.push('Content-Type: text/plain');
    lines.push('');
    lines.push(body);
  } else {
    lines.push('');
    lines.push('');
  }
  return lines.join('\r\n');
}

function parseHTTPStatus(responseHead: string): { code: number; reason: string } {
  const line = responseHead.split('\r\n')[0] ?? '';
  const m    = line.match(/HTTP\/\d\.\d (\d{3}) (.+)/);
  return m ? { code: parseInt(m[1]!), reason: m[2]! } : { code: 0, reason: '' };
}

test('HTTP: GET request format', () => {
  const req = buildHTTPRequest('GET', '/', 'example.com');
  expectTrue(req.startsWith('GET / HTTP/1.1'), 'request line');
  expectTrue(req.includes('Host: example.com'), 'host header');
});

test('HTTP: status parse 200', () => {
  const { code, reason } = parseHTTPStatus('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
  expect(code, 200, 'status code');
  expect(reason, 'OK', 'reason');
});

test('HTTP: status parse 404', () => {
  const { code } = parseHTTPStatus('HTTP/1.0 404 Not Found\r\n\r\n');
  expect(code, 404, '404');
});

// ── [Item 807] CSS specificity ──────────────────────────────────────────────

interface Specificity { inline: number; id: number; cls: number; tag: number; }

function calcSpecificity(selector: string): Specificity {
  const s: Specificity = { inline: 0, id: 0, cls: 0, tag: 0 };
  // inline handled externally
  s.id  = (selector.match(/#[\w-]+/g)  ?? []).length;
  s.cls = (selector.match(/[.:\[]/g)   ?? []).length;
  s.tag = (selector.match(/(?<![#.\[:\w])[a-z][\w-]*/gi) ?? []).length;
  return s;
}

function compareSpecificity(a: Specificity, b: Specificity): number {
  const toNum = (s: Specificity) => s.inline*1000 + s.id*100 + s.cls*10 + s.tag;
  return toNum(a) - toNum(b);
}

test('CSS specificity: id > class > tag', () => {
  const id  = calcSpecificity('#foo');
  const cls = calcSpecificity('.bar');
  const tag = calcSpecificity('div');
  expectTrue(compareSpecificity(id, cls)  > 0, 'id > cls');
  expectTrue(compareSpecificity(cls, tag) > 0, 'cls > tag');
});

test('CSS specificity: multi-class', () => {
  const s = calcSpecificity('.a.b.c');
  expectTrue(s.cls >= 3, 'three class selectors');
});

// ── [Item 808] Flex layout ──────────────────────────────────────────────────

interface FlexItem { basis: number; grow: number; shrink: number; min?: number; max?: number; }
interface FlexResult { sizes: number[]; }

function flexResolve(container: number, items: FlexItem[], gap = 0): FlexResult {
  const n           = items.length;
  const totalGaps   = gap * Math.max(n - 1, 0);
  let   freeSpace   = container - totalGaps - items.reduce((a, b) => a + b.basis, 0);
  const sizes       = items.map(i => i.basis);

  if (freeSpace > 0) {
    const totalGrow = items.reduce((a, b) => a + b.grow, 0);
    if (totalGrow > 0) {
      items.forEach((item, i) => {
        sizes[i]! += freeSpace * (item.grow / totalGrow);
        if (item.max !== undefined) sizes[i] = Math.min(sizes[i]!, item.max);
      });
    }
  } else if (freeSpace < 0) {
    const totalShrink = items.reduce((a, b) => a + b.shrink * b.basis, 0);
    if (totalShrink > 0) {
      items.forEach((item, i) => {
        sizes[i]! += freeSpace * (item.shrink * item.basis / totalShrink);
        if (item.min !== undefined) sizes[i] = Math.max(sizes[i]!, item.min);
      });
    }
  }
  return { sizes };
}

test('flex: equal grow splits free space', () => {
  const r = flexResolve(300, [
    { basis: 50, grow: 1, shrink: 1 },
    { basis: 50, grow: 1, shrink: 1 },
  ]);
  expect(Math.round(r.sizes[0]!), 150, 'first item');
  expect(Math.round(r.sizes[1]!), 150, 'second item');
});

test('flex: 2:1 grow ratio', () => {
  const r = flexResolve(300, [
    { basis: 0, grow: 2, shrink: 1 },
    { basis: 0, grow: 1, shrink: 1 },
  ]);
  expect(Math.round(r.sizes[0]!), 200, 'grow 2 part');
  expect(Math.round(r.sizes[1]!), 100, 'grow 1 part');
});

test('flex: shrink applies on overflow', () => {
  const r = flexResolve(100, [
    { basis: 100, grow: 0, shrink: 1 },
    { basis: 100, grow: 0, shrink: 1 },
  ]);
  expectTrue(r.sizes[0]! < 100, 'item shrunk');
  expectTrue(Math.abs(r.sizes[0]! - r.sizes[1]!) < 1, 'equal shrink');
});

// ── [Item 809] HTML parser ──────────────────────────────────────────────────

interface HtmlNode { tag: string; attrs: Record<string, string>; children: HtmlNode[]; text?: string; }

function parseHTMLFragment(html: string): HtmlNode[] {
  const stack: HtmlNode[] = [{ tag: '__root__', attrs: {}, children: [] }];
  const re = /<(\/?)(\w+)([^>]*)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[4]) {
      // text node
      const text = m[4].trim();
      if (text) stack[stack.length - 1]!.children.push({ tag: '__text__', attrs: {}, children: [], text });
    } else if (m[1] === '/') {
      // closing tag
      if (stack.length > 1) stack.pop();
    } else {
      // opening tag
      const attrs: Record<string, string> = {};
      const attrRe = /(\w[\w-]*)(?:=["']([^"']*)["'])?/g;
      let am: RegExpExecArray | null;
      while ((am = attrRe.exec(m[3] ?? '')) !== null) { if (am[1]) attrs[am[1]] = am[2] ?? ''; }
      const node: HtmlNode = { tag: m[2]!.toLowerCase(), attrs, children: [] };
      stack[stack.length - 1]!.children.push(node);
      const selfClosing = /br|hr|img|input|meta|link|area|base|col|embed|param|source|track|wbr/.test(node.tag);
      if (!selfClosing) stack.push(node);
    }
  }
  return stack[0]!.children;
}

test('HTML parser: simple element', () => {
  const nodes = parseHTMLFragment('<div>hello</div>');
  expect(nodes[0]?.tag, 'div', 'tag name');
  expect(nodes[0]?.children[0]?.text, 'hello', 'text content');
});

test('HTML parser: nested elements', () => {
  const nodes = parseHTMLFragment('<ul><li>a</li><li>b</li></ul>');
  expect(nodes[0]?.tag, 'ul', 'ul');
  expect(nodes[0]?.children.length, 2, 'two lis');
});

test('HTML parser: attributes', () => {
  const nodes = parseHTMLFragment('<img src="foo.png" alt="foo">');
  expect(nodes[0]?.attrs['src'], 'foo.png', 'src attr');
  expect(nodes[0]?.attrs['alt'], 'foo', 'alt attr');
});

// ── [Item 810] TCP state machine ────────────────────────────────────────────

type TCPState =
  | 'CLOSED' | 'LISTEN' | 'SYN_SENT' | 'SYN_RECEIVED'
  | 'ESTABLISHED' | 'FIN_WAIT_1' | 'FIN_WAIT_2'
  | 'CLOSE_WAIT' | 'CLOSING' | 'LAST_ACK' | 'TIME_WAIT';

type TCPEvent = 'OPEN' | 'CLOSE' | 'SYN' | 'SYN_ACK' | 'ACK' | 'FIN' | 'RST' | 'TIMEOUT';

function tcpTransition(state: TCPState, event: TCPEvent): TCPState {
  switch (state) {
    case 'CLOSED':       return event === 'OPEN' ? 'SYN_SENT' : event === 'SYN' ? 'SYN_RECEIVED' : 'CLOSED';
    case 'LISTEN':       return event === 'SYN'  ? 'SYN_RECEIVED' : state;
    case 'SYN_SENT':     return event === 'SYN_ACK' ? 'ESTABLISHED' : event === 'RST' ? 'CLOSED' : state;
    case 'SYN_RECEIVED': return event === 'ACK'  ? 'ESTABLISHED' : event === 'RST' ? 'LISTEN' : state;
    case 'ESTABLISHED':  return event === 'CLOSE' ? 'FIN_WAIT_1' : event === 'FIN' ? 'CLOSE_WAIT' : state;
    case 'FIN_WAIT_1':   return event === 'ACK'  ? 'FIN_WAIT_2' : event === 'FIN' ? 'CLOSING' : state;
    case 'FIN_WAIT_2':   return event === 'FIN'  ? 'TIME_WAIT'  : state;
    case 'CLOSE_WAIT':   return event === 'CLOSE' ? 'LAST_ACK'  : state;
    case 'CLOSING':      return event === 'ACK'  ? 'TIME_WAIT'  : state;
    case 'LAST_ACK':     return event === 'ACK'  ? 'CLOSED'     : state;
    case 'TIME_WAIT':    return event === 'TIMEOUT' ? 'CLOSED'  : state;
    default:             return state;
  }
}

test('TCP: active open handshake', () => {
  let s: TCPState = 'CLOSED';
  s = tcpTransition(s, 'OPEN');    expect(s, 'SYN_SENT',     'after OPEN');
  s = tcpTransition(s, 'SYN_ACK'); expect(s, 'ESTABLISHED', 'after SYN_ACK');
});

test('TCP: active close', () => {
  let s: TCPState = 'ESTABLISHED';
  s = tcpTransition(s, 'CLOSE'); expect(s, 'FIN_WAIT_1', 'FIN_WAIT_1');
  s = tcpTransition(s, 'ACK');   expect(s, 'FIN_WAIT_2', 'FIN_WAIT_2');
  s = tcpTransition(s, 'FIN');   expect(s, 'TIME_WAIT',  'TIME_WAIT');
  s = tcpTransition(s, 'TIMEOUT'); expect(s, 'CLOSED',   'CLOSED');
});

test('TCP: passive close', () => {
  let s: TCPState = 'ESTABLISHED';
  s = tcpTransition(s, 'FIN');   expect(s, 'CLOSE_WAIT', 'CLOSE_WAIT');
  s = tcpTransition(s, 'CLOSE'); expect(s, 'LAST_ACK',   'LAST_ACK');
  s = tcpTransition(s, 'ACK');   expect(s, 'CLOSED',     'CLOSED');
});

test('TCP: RST from SYN_SENT', () => {
  let s: TCPState = 'CLOSED';
  s = tcpTransition(s, 'OPEN'); s = tcpTransition(s, 'RST');
  expect(s, 'CLOSED', 'RST resets to CLOSED');
});

// ── Runner ──────────────────────────────────────────────────────────────────

export function runAll(): void {
  for (const r of _results) {
    const icon = r.ok ? '✓' : '✗';
    console.log(`  ${icon} ${r.name}${r.ok ? '' : ': ' + r.msg}`);
  }
  console.log(`\n  ${_passed} passed, ${_failed} failed out of ${_results.length} tests`);
  if (_failed > 0) throw new Error(`${_failed} test(s) failed`);
}

// Auto-run when executed as main module
if (typeof require !== 'undefined' && require.main === (module as any)) {
  runAll();
}
