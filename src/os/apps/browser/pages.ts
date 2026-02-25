// ── Built-in about: page generators ──────────────────────────────────────────
// These return raw HTML strings that are fed through parseHTML + layoutNodes.

export function aboutJsosHTML(): string {
  return [
    '<h1>JSOS Browser</h1>',
    '<p>Welcome to the JSOS native TypeScript browser — running on bare metal,',
    'built entirely in TypeScript with no Chromium or external runtimes.</p>',

    '<h2>About JSOS</h2>',
    '<p><strong>JSOS</strong> is an operating system written entirely in TypeScript',
    'running on a bare-metal i686 PC via QuickJS (ES2023).</p>',
    '<blockquote>TypeScript is not a guest in this OS — TypeScript <em>IS</em> the OS.</blockquote>',

    '<h2>Browser Features</h2>',
    '<ul>',
    '<li><strong>HTML</strong>: h1&ndash;h6, p, a, ul/ol (nested), pre/code, blockquote, hr, table, img</li>',
    '<li><strong>Inline</strong>: &lt;strong&gt;, &lt;em&gt;, &lt;code&gt;, &lt;del&gt;, &lt;mark&gt;, &lt;u&gt;, &lt;cite&gt;, &lt;q&gt;</li>',
    '<li><strong>CSS</strong>: inline <code>style=""</code> for color, background-color, font-weight, font-style,',
    'text-decoration, text-align, display:none</li>',
    '<li><strong>Forms</strong>: &lt;input&gt; text/password/submit/reset/checkbox/radio,',
    '&lt;textarea&gt;, &lt;select&gt;, &lt;button&gt; &mdash; GET and POST</li>',
    '<li><strong>Images</strong>: BMP decode + pixel render; PNG/JPEG show sized placeholder</li>',
    '<li><strong>data: URLs</strong>: text/html and text/plain data: page sources</li>',
    '<li><strong>Networking</strong>: DNS, HTTP/1.1, HTTPS via TLS 1.3</li>',
    '<li><strong>Find in page</strong>: Ctrl+F, n/N cycle, Esc close</li>',
    '<li><strong>Bookmarks</strong>: Ctrl+D to save</li>',
    '</ul>',

    '<h2>Keyboard Shortcuts</h2>',
    '<ul>',
    '<li><code>Ctrl+L</code> &mdash; focus URL bar</li>',
    '<li><code>Ctrl+R</code> &mdash; reload</li>',
    '<li><code>Ctrl+D</code> &mdash; bookmark page</li>',
    '<li><code>Ctrl+F</code> &mdash; find in page</li>',
    '<li><code>Tab</code> &mdash; cycle form fields</li>',
    '<li><code>b / f</code> &mdash; back / forward</li>',
    '<li><code>Space / PgDn</code> &mdash; scroll down</li>',
    '<li><code>PgUp</code> &mdash; scroll up</li>',
    '<li><code>Home / End</code> &mdash; top / bottom</li>',
    '</ul>',

    '<h2>CSS Demo</h2>',
    '<p style="color:#1558D6;font-weight:bold">Blue bold text via style=""</p>',
    '<p style="background-color:#FFF3CD;color:#664D03">Highlighted paragraph</p>',
    '<p><span style="color:crimson">Crimson</span>, ',
    '<span style="color:forestgreen">forest green</span>, ',
    '<span style="text-decoration:underline">underlined</span>, ',
    '<span style="text-decoration:line-through">strikethrough</span></p>',

    '<h2>Demo Form</h2>',
    '<form action="about:jsos" method="get">',
    '<p>Name: <input type="text" name="name" placeholder="Your name"></p>',
    '<p>Password: <input type="password" name="pw"></p>',
    '<p>Remember me: <input type="checkbox" name="remember" value="1"></p>',
    '<p>Colour:',
    '  <input type="radio" name="clr" value="red"> Red',
    '  <input type="radio" name="clr" value="blue" checked> Blue',
    '</p>',
    '<p>Version:',
    '<select name="ver">',
    '<option value="1">JSOS 1.0</option>',
    '<option value="2" selected>JSOS 2.0</option>',
    '</select></p>',
    '<p>Comment:<br><textarea name="comment" rows="3" cols="40" placeholder="Type here..."></textarea></p>',
    '<p><input type="submit" value="Submit"> <input type="reset" value="Reset"></p>',
    '</form>',

    '<h2>Links</h2>',
    '<ul>',
    '<li><a href="about:history">Browsing history</a></li>',
    '<li><a href="about:bookmarks">Bookmarks</a></li>',
    '<li><a href="about:source">View page source</a></li>',
    '<li><a href="about:blank">Blank page</a></li>',
    '</ul>',
  ].join('\n');
}

export function errorHTML(url: string, reason: string): string {
  return [
    '<h1>Cannot reach this page</h1>',
    '<p><strong>' + url + '</strong></p>',
    '<p>' + reason + '</p>',
    '<hr>',
    '<p><a href="about:jsos">JSOS Browser Home</a></p>',
  ].join('\n');
}

/**
 * Convert a JSON value to a pretty-printed HTML string with syntax
 * highlighting via inline spans.
 */
export function jsonViewerHTML(title: string, json: unknown): string {
  function escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function renderValue(val: unknown, depth: number): string {
    var indent = '  '.repeat(depth);
    var indent1 = '  '.repeat(depth + 1);
    if (val === null) return '<span style="color:#B5200D">null</span>';
    if (typeof val === 'boolean')
      return '<span style="color:#B5200D">' + val + '</span>';
    if (typeof val === 'number')
      return '<span style="color:#1C6CB5">' + val + '</span>';
    if (typeof val === 'string')
      return '<span style="color:#007A00">&quot;' + escape(val) + '&quot;</span>';
    if (Array.isArray(val)) {
      if (val.length === 0) return '[]';
      var items = val.map(function(v) { return indent1 + renderValue(v, depth + 1); });
      return '[\n' + items.join(',\n') + '\n' + indent + ']';
    }
    if (typeof val === 'object') {
      var keys = Object.keys(val as Record<string, unknown>);
      if (keys.length === 0) return '{}';
      var pairs = keys.map(function(k) {
        var kSpan = '<span style="color:#800080">&quot;' + escape(k) + '&quot;</span>';
        return indent1 + kSpan + ': ' + renderValue((val as Record<string, unknown>)[k], depth + 1);
      });
      return '{\n' + pairs.join(',\n') + '\n' + indent + '}';
    }
    return escape(String(val));
  }

  var body = '';
  try {
    var parsed = (typeof json === 'string') ? JSON.parse(json) : json;
    body = '<pre>' + renderValue(parsed, 0) + '</pre>';
  } catch (e) {
    body = '<pre style="color:red">JSON parse error: ' + escape(String(e)) + '</pre>';
  }
  return '<h1>JSON: ' + escape(title) + '</h1>' + body;
}
