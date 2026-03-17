/**
 * Content Security Policy (CSP) enforcement for the JSOS browser.
 *
 * Parses the `Content-Security-Policy` response header and enforces:
 *   - script-src:  controls which scripts may execute
 *   - style-src:   controls which stylesheets may apply
 *   - img-src:     controls which images may load
 *   - connect-src: controls which URLs may be fetched via fetch/XHR/WebSocket
 *   - default-src: fallback for any directive not explicitly listed
 *   - font-src:    controls which fonts may load
 *   - media-src:   controls which media may load
 *
 * Special source values:
 *   'self'              — same origin as the page
 *   'none'              — block everything
 *   'unsafe-inline'     — allow inline scripts/styles
 *   'unsafe-eval'       — allow eval()
 *   *                   — wildcard: allow any origin
 *   data:               — allow data: URLs
 *   blob:               — allow blob: URLs
 *   https:              — allow any HTTPS origin
 *   *.example.com       — wildcard subdomain matching
 *   https://cdn.example.com — exact origin match
 */

export interface CSPPolicy {
  /** Raw header value. */
  raw: string;
  /** Parsed directives: directive name → list of source expressions. */
  directives: Map<string, string[]>;
}

/**
 * Parse a Content-Security-Policy header value into a CSPPolicy.
 * Multiple directives are separated by semicolons.
 * Each directive: `directive-name source1 source2 ...`
 */
export function parseCSP(headerValue: string): CSPPolicy {
  var directives = new Map<string, string[]>();
  var parts = headerValue.split(';');
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (!p) continue;
    var tokens = p.split(/\s+/);
    var name = tokens[0].toLowerCase();
    var sources = tokens.slice(1);
    directives.set(name, sources);
  }
  return { raw: headerValue, directives };
}

/**
 * Check whether a given URL is allowed by a CSP directive.
 *
 * @param policy     The parsed CSP policy
 * @param directive  The directive to check (e.g. 'script-src', 'img-src')
 * @param url        The URL being loaded
 * @param pageOrigin The origin of the current page (for 'self' matching)
 * @param isInline   True if this is an inline script/style (for 'unsafe-inline')
 * @param isEval     True if this is an eval() call (for 'unsafe-eval')
 * @returns true if load is allowed, false if blocked
 */
export function cspAllows(
  policy: CSPPolicy | null,
  directive: string,
  url: string,
  pageOrigin: string,
  isInline: boolean = false,
  isEval:   boolean = false,
): boolean {
  // No CSP → allow everything
  if (!policy || policy.directives.size === 0) return true;

  // Find applicable sources: check the specific directive, fall back to default-src
  var sources = policy.directives.get(directive)
             ?? policy.directives.get('default-src');

  // No directive and no default-src → allow (CSP only restricts what's declared)
  if (!sources) return true;

  // 'none' blocks everything
  if (sources.length === 1 && sources[0] === "'none'") return false;

  for (var i = 0; i < sources.length; i++) {
    var src = sources[i];

    // Wildcard: allow all
    if (src === '*') return true;

    // 'unsafe-inline' for inline scripts/styles
    if (src === "'unsafe-inline'" && isInline) return true;

    // 'unsafe-eval' for eval()
    if (src === "'unsafe-eval'" && isEval) return true;

    // 'self' — same origin
    if (src === "'self'") {
      if (_matchesOrigin(url, pageOrigin)) return true;
      continue;
    }

    // data: scheme
    if (src === 'data:' && url.startsWith('data:')) return true;

    // blob: scheme
    if (src === 'blob:' && url.startsWith('blob:')) return true;

    // https: — any HTTPS origin
    if (src === 'https:' && url.startsWith('https:')) return true;

    // http: — any HTTP origin
    if (src === 'http:' && url.startsWith('http:')) return true;

    // Origin or wildcard subdomain match
    if (_matchesSourceExpression(url, src, pageOrigin)) return true;
  }

  return false;
}

/**
 * Check whether a URL matches the page's origin.
 */
function _matchesOrigin(url: string, pageOrigin: string): boolean {
  if (!pageOrigin) return false;
  var urlOrigin = _extractOrigin(url);
  return urlOrigin === pageOrigin;
}

/**
 * Extract origin (scheme + host + port) from a URL string without using URL class.
 * Returns e.g. "https://example.com" or "http://example.com:8080".
 */
function _extractOrigin(url: string): string {
  var schemeEnd = url.indexOf('://');
  if (schemeEnd < 0) return '';
  var scheme = url.slice(0, schemeEnd);
  var rest   = url.slice(schemeEnd + 3);
  // Strip userinfo
  var atIdx = rest.indexOf('@');
  if (atIdx >= 0) rest = rest.slice(atIdx + 1);
  // Find end of host (before path, query, fragment)
  var hostEnd = rest.length;
  for (var i = 0; i < rest.length; i++) {
    var ch = rest.charCodeAt(i);
    if (ch === 0x2F || ch === 0x3F || ch === 0x23) { hostEnd = i; break; } // '/', '?', '#'
  }
  var hostPort = rest.slice(0, hostEnd).toLowerCase();
  // Strip default ports
  if (scheme === 'https' && hostPort.endsWith(':443')) {
    hostPort = hostPort.slice(0, -4);
  } else if (scheme === 'http' && hostPort.endsWith(':80')) {
    hostPort = hostPort.slice(0, -3);
  }
  return scheme + '://' + hostPort;
}

/**
 * Match a URL against a CSP source expression.
 * Handles:
 *   - Exact origin: https://cdn.example.com
 *   - Wildcard subdomain: *.example.com
 *   - Scheme + host: https://example.com
 */
function _matchesSourceExpression(url: string, source: string, _pageOrigin: string): boolean {
  var urlOrigin = _extractOrigin(url);
  if (!urlOrigin) return false;

  // Extract hostname from URL origin: "https://cdn.example.com" → "cdn.example.com"
  var schEnd = urlOrigin.indexOf('://');
  var urlScheme = schEnd >= 0 ? urlOrigin.slice(0, schEnd) : '';
  var urlHost = schEnd >= 0 ? urlOrigin.slice(schEnd + 3) : urlOrigin;

  // Wildcard subdomain: *.example.com
  if (source.startsWith('*.')) {
    var domain = source.slice(2).toLowerCase();
    var host = urlHost.toLowerCase();
    // Strip port for host matching
    var colonIdx = host.indexOf(':');
    if (colonIdx >= 0) host = host.slice(0, colonIdx);
    return host === domain || host.endsWith('.' + domain);
  }

  // Full origin: https://cdn.example.com  or  https://cdn.example.com:8080
  if (source.indexOf('://') >= 0) {
    var srcOrigin = _extractOrigin(source);
    return urlOrigin === srcOrigin;
  }

  // Bare hostname: example.com
  var hostOnly = urlHost.toLowerCase();
  var colonIdx2 = hostOnly.indexOf(':');
  if (colonIdx2 >= 0) hostOnly = hostOnly.slice(0, colonIdx2);
  return hostOnly === source.toLowerCase();
}

/** CSP violation log entry. */
export interface CSPViolation {
  directive: string;
  blockedURL: string;
  pageURL: string;
  timestamp: number;
}

/** In-memory violation log. */
var _violations: CSPViolation[] = [];
var MAX_VIOLATIONS = 200;

/** Log a CSP violation. */
export function logCSPViolation(directive: string, blockedURL: string, pageURL: string): void {
  if (_violations.length >= MAX_VIOLATIONS) _violations.shift();
  _violations.push({ directive, blockedURL, pageURL, timestamp: Date.now() });
}

/** Get recent CSP violations. */
export function getCSPViolations(): CSPViolation[] {
  return _violations.slice();
}

/** Clear CSP violation log. */
export function clearCSPViolations(): void {
  _violations = [];
}
