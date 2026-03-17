/**
 * JSOS NPM-Compatible Package Registry
 * Item 741 — a minimal registry that speaks the npm HTTP API
 *
 * Serves:
 *   GET  /:packageName                → package metadata JSON
 *   GET  /:packageName/-/:tarball     → tarball download
 *   PUT  /:packageName                → publish a package
 *   GET  /-/v1/search?text=foo        → search
 *
 * Packages are stored as tarballs in the filesystem under /var/lib/npm-registry/.
 * The registry manifest (versions, dist-tags, dist.tarball URLs) is stored
 * in memory and persisted as JSON to /var/lib/npm-registry/<pkg>/meta.json.
 */

declare const sys: any;

const REGISTRY_ROOT = '/var/lib/npm-registry';
const PORT          = 4873;   // same default as Verdaccio

// ── Types ──────────────────────────────────────────────────────────────────

export interface NpmVersionManifest {
  name: string;
  version: string;
  description?: string;
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dist: { tarball: string; shasum: string; integrity?: string };
  _id?: string;
}

export interface NpmPackageMeta {
  name: string;
  description?: string;
  'dist-tags': Record<string, string>;
  versions: Record<string, NpmVersionManifest>;
  time?: Record<string, string>;
}

// ── In-memory store ────────────────────────────────────────────────────────

const packages = new Map<string, NpmPackageMeta>();

function loadMeta(name: string): NpmPackageMeta | null {
  try {
    const raw = sys.fs.readFile(`${REGISTRY_ROOT}/${name}/meta.json`, 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

function saveMeta(meta: NpmPackageMeta): void {
  const dir = `${REGISTRY_ROOT}/${meta.name}`;
  try { sys.fs.mkdir(dir); } catch {}
  sys.fs.writeFile(`${dir}/meta.json`, JSON.stringify(meta, null, 2), 'utf8');
  packages.set(meta.name, meta);
}

function getMeta(name: string): NpmPackageMeta | null {
  if (packages.has(name)) return packages.get(name)!;
  const loaded = loadMeta(name);
  if (loaded) packages.set(name, loaded);
  return loaded;
}

// ── Route handlers ─────────────────────────────────────────────────────────

function handleGetPackage(name: string, baseUrl: string): { status: number; body: string } {
  const meta = getMeta(name);
  if (!meta) return { status: 404, body: JSON.stringify({ error: `Package '${name}' not found` }) };

  // Rewrite tarball URLs to point to our server
  const out: NpmPackageMeta = { ...meta, versions: {} };
  for (const [ver, manifest] of Object.entries(meta.versions)) {
    out.versions[ver] = {
      ...manifest,
      dist: { ...manifest.dist, tarball: `${baseUrl}/${name}/-/${name}-${ver}.tgz` },
    };
  }
  return { status: 200, body: JSON.stringify(out) };
}

function handleGetTarball(name: string, filename: string): { status: number; body: Uint8Array | null } {
  try {
    const data = sys.fs.readFile(`${REGISTRY_ROOT}/${name}/${filename}`);
    return { status: 200, body: data };
  } catch {
    return { status: 404, body: null };
  }
}

function handlePublish(name: string, body: string): { status: number; body: string } {
  let payload: any;
  try { payload = JSON.parse(body); } catch { return { status: 400, body: '{"error":"bad JSON"}' }; }

  const versions: Record<string, NpmVersionManifest> = payload.versions ?? {};
  const attachments: Record<string, { data: string }> = payload._attachments ?? {};

  let meta = getMeta(name) ?? {
    name,
    description: payload.description ?? '',
    'dist-tags': {},
    versions: {},
  };

  for (const [ver, manifest] of Object.entries(versions)) {
    meta.versions[ver] = manifest as NpmVersionManifest;
  }

  if (payload['dist-tags']) {
    Object.assign(meta['dist-tags'], payload['dist-tags']);
  }

  // Write tarballs
  for (const [filename, att] of Object.entries(attachments)) {
    const dir = `${REGISTRY_ROOT}/${name}`;
    try { sys.fs.mkdir(dir); } catch {}
    const buf = base64Decode(att.data);
    sys.fs.writeFile(`${dir}/${filename}`, buf);
  }

  saveMeta(meta);
  return { status: 200, body: JSON.stringify({ ok: true, id: name }) };
}

function handleSearch(query: string): { status: number; body: string } {
  const q = query.toLowerCase();
  const results: any[] = [];
  for (const meta of packages.values()) {
    if (meta.name.toLowerCase().includes(q) ||
        (meta.description ?? '').toLowerCase().includes(q)) {
      const latest = meta['dist-tags'].latest ?? Object.keys(meta.versions).pop() ?? '';
      results.push({ package: { name: meta.name, description: meta.description ?? '', version: latest } });
    }
  }
  return { status: 200, body: JSON.stringify({ objects: results, total: results.length }) };
}

// ── Base64 decode helper ───────────────────────────────────────────────────

function base64Decode(s: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  s = s.replace(/[^A-Za-z0-9+/]/g, '');
  const n = s.length;
  const out = new Uint8Array(Math.floor(n * 3 / 4));
  let i = 0, j = 0;
  while (i < n - 3) {
    const a = chars.indexOf(s[i++]), b = chars.indexOf(s[i++]);
    const c = chars.indexOf(s[i++]), d = chars.indexOf(s[i++]);
    out[j++] = (a << 2) | (b >> 4);
    out[j++] = ((b & 0xf) << 4) | (c >> 2);
    out[j++] = ((c & 0x03) << 6) | d;
  }
  return out.subarray(0, j);
}

// ── HTTP server ────────────────────────────────────────────────────────────

function sendResponse(socket: any, status: number, body: string | Uint8Array, contentType: string): void {
  const bodyBytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const header    = `HTTP/1.1 ${status} ${status === 200 ? 'OK' : status === 404 ? 'Not Found' : 'Error'}\r\n` +
                    `Content-Type: ${contentType}\r\n` +
                    `Content-Length: ${bodyBytes.length}\r\n` +
                    `Connection: close\r\n\r\n`;
  socket.write(new TextEncoder().encode(header));
  socket.write(bodyBytes);
  socket.close();
}

export function startRegistry(port = PORT): void {
  try { sys.fs.mkdir(REGISTRY_ROOT); } catch {}

  const server = sys.net.createSocket();
  server.bind(port);
  server.listen();

  console.log(`[npm-registry] Listening on :${port}`);

  function acceptLoop(): void {
    const client = server.accept();
    sys.process.nextTick(() => handleClient(client));
    acceptLoop();
  }

  function handleClient(socket: any): void {
    try {
      const rawReq = socket.read(8192);
      if (!rawReq) return;
      const req = new TextDecoder().decode(rawReq);
      const lines = req.split('\r\n');
      const [method, rawPath] = lines[0].split(' ');
      const url = new URL(rawPath, `http://localhost:${port}`);

      const bodyStart = req.indexOf('\r\n\r\n');
      const body = bodyStart >= 0 ? req.slice(bodyStart + 4) : '';
      const baseUrl = `http://localhost:${port}`;

      // Route: GET /-/v1/search
      if (method === 'GET' && url.pathname === '/-/v1/search') {
        const { status, body: resBody } = handleSearch(url.searchParams.get('text') ?? '');
        return sendResponse(socket, status, resBody, 'application/json');
      }

      // Route: GET /:pkg/-/:tarball  or  GET /:pkg
      const parts = url.pathname.split('/').filter(Boolean);
      if (method === 'GET' && parts.length >= 3 && parts[1] === '-') {
        const { status, body: resBody } = handleGetTarball(parts[0], parts[2]);
        if (status === 200 && resBody) return sendResponse(socket, 200, resBody, 'application/octet-stream');
        return sendResponse(socket, 404, '{"error":"not found"}', 'application/json');
      }
      if (method === 'GET' && parts.length === 1) {
        const { status, body: resBody } = handleGetPackage(parts[0], baseUrl);
        return sendResponse(socket, status, resBody, 'application/json');
      }
      if (method === 'PUT' && parts.length === 1) {
        const { status, body: resBody } = handlePublish(parts[0], body);
        return sendResponse(socket, status, resBody, 'application/json');
      }

      sendResponse(socket, 404, '{"error":"not found"}', 'application/json');
    } catch (e) {
      try { socket.close(); } catch {}
    }
  }

  acceptLoop();
}
