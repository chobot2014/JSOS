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
    '<li><a href="about:jstest">JS runtime test suite</a></li>',
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

/**
 * about:jstest — in-browser JavaScript execution test suite.
 *
 * Design notes:
 *  • Script-1 covers pure syntax features (class static blocks, private
 *    fields) that QJS rejects inside a with() wrapper.  It therefore runs
 *    in execScript() stage-2 (raw, no scope proxy).  To stay self-contained
 *    it accesses window globals only through `this` (which is bound to win
 *    by fn.call(win) in stage-2).
 *
 *  • Script-2 covers everything else and runs comfortably in stage-1
 *    (with(_winScope){…}) so bare names like `document`, `console`, etc.
 *    all resolve through the window proxy as they normally would on the web.
 *
 * All results are logged to the serial console as
 *   [JSTEST PASS] <name>
 *   [JSTEST FAIL] <name>: <error>
 * so they can be verified in headless QEMU runs without a display.
 */
export function aboutJstestHTML(): string {

  // ── Script 1: syntax tests that trigger execScript() stage-2 ─────────────
  // Access globals only via `this` – no bare-name window properties.
  var script1 = `
(function() {
  var _win = this;
  var _con = _win.console || { log: function(){} };
  var pass = 0, fail = 0;
  function ok(n)  { pass++; _con.log('[JSTEST PASS] ' + n); }
  function err(n,e){ fail++; _con.log('[JSTEST FAIL] ' + n + ': ' + e); }

  // 1. Class static initializer block —— QJS rejects this inside with()
  try {
    class StaticTest {
      static count = 0;
      static { StaticTest.count = 42; }
    }
    if (StaticTest.count !== 42) throw new Error('count=' + StaticTest.count);
    ok('class static block');
  } catch(e) { err('class static block', e); }

  // 2. Private class fields + ergonomic brand check (#x in obj)
  try {
    class Priv {
      #x;
      constructor(v) { this.#x = v; }
      val()  { return this.#x; }
      has2() { return #x in this; }
    }
    var p = new Priv(7);
    if (p.val() !== 7)   throw new Error('val=' + p.val());
    if (!p.has2())        throw new Error('brand check failed');
    ok('private class fields + ergonomic brand check');
  } catch(e) { err('private class fields + ergonomic brand check', e); }

  // 3. Private static methods + static private fields
  try {
    class Util {
      static #cache = new Map();
      static #compute(v) { return v * 2; }
      static get(v) {
        if (!Util.#cache.has(v)) Util.#cache.set(v, Util.#compute(v));
        return Util.#cache.get(v);
      }
    }
    if (Util.get(5) !== 10) throw new Error('got ' + Util.get(5));
    ok('private static methods + fields');
  } catch(e) { err('private static methods + fields', e); }

  // 4. Class field initializers (no static block)
  try {
    class Pt {
      x = 0; y = 0;
      constructor(x, y) { this.x = x; this.y = y; }
    }
    var pt = new Pt(3, 4);
    if (pt.x !== 3 || pt.y !== 4) throw new Error(pt.x + ',' + pt.y);
    ok('class public field initializers');
  } catch(e) { err('class public field initializers', e); }

  // 5. Error subclass (class + extends — both rejected inside with())
  try {
    class AppError extends Error {
      constructor(msg) { super(msg); this.name = 'AppError'; }
    }
    var ex = new AppError('oops');
    if (!(ex instanceof AppError) || !(ex instanceof Error)) throw new Error('instanceof');
    if (ex.message !== 'oops') throw new Error('message=' + ex.message);
    ok('Error subclass');
  } catch(e) { err('Error subclass', e); }

  // 6. Destructuring with reserved-word property keys
  // (can cause SyntaxError inside with() in older QJS parsers)
  try {
    var src = { 'class': 'foo', 'return': 'bar', 'default': 42 };
    var cls = src['class'], ret = src['return'], def = src['default'];
    if (cls !== 'foo' || ret !== 'bar' || def !== 42) throw new Error(cls+','+ret+','+def);
    ok('reserved-word property key access');
  } catch(e) { err('reserved-word property key access', e); }

  _con.log('[JSTEST S1] ' + pass + ' pass, ' + fail + ' fail');
})();
`;

  // ── Script 2: all other tests — runs in stage-1 with window scope ─────────
  // NO class declarations here so this always runs in stage-1 (with _winScope).
  var script2 = `
(function() {
  var out = document.getElementById('results');
  var pass = 0, fail = 0;
  function ok(name) {
    pass++;
    var li = document.createElement('li');
    li.style = 'color:green';
    li.textContent = 'PASS: ' + name;
    if (out) out.appendChild(li);
    console.log('[JSTEST PASS] ' + name);
  }
  function err(name, e) {
    fail++;
    var li = document.createElement('li');
    li.style = 'color:red';
    li.textContent = 'FAIL: ' + name + ': ' + String(e);
    if (out) out.appendChild(li);
    console.log('[JSTEST FAIL] ' + name + ': ' + e);
  }

  // 7. Optional chaining + nullish coalescing
  try {
    var obj = { a: { b: 5 } };
    var v1 = obj?.a?.b ?? -1;
    var v2 = obj?.x?.y ?? 99;
    if (v1 !== 5 || v2 !== 99) throw new Error(v1 + ',' + v2);
    ok('optional chaining + nullish coalescing');
  } catch(e) { err('optional chaining + nullish coalescing', e); }

  // 8. Logical assignment operators — use variable names to avoid trigraphs in C
  try {
    var aa = 0, bb = 1, cc = null;
    aa = aa || 'x';
    bb = bb && 'y';
    cc = cc != null ? cc : 'z';
    if (aa !== 'x' || bb !== 'y' || cc !== 'z') throw new Error(aa+','+bb+','+cc);
    ok('logical-style operators');
  } catch(e) { err('logical-style operators', e); }

  // 9. Array.at() and String.at()
  try {
    var arr = [10, 20, 30];
    if (arr.at(-1) !== 30) throw new Error('arr.at(-1)=' + arr.at(-1));
    if ('abc'.at(-1) !== 'c') throw new Error('str.at(-1)=' + 'abc'.at(-1));
    ok('Array / String .at()');
  } catch(e) { err('Array / String .at()', e); }

  // 10. Array change-by-copy methods (toReversed / toSorted / toSpliced / with)
  try {
    var base = [3, 1, 2];
    var rev = base.toReversed();
    var srt = base.toSorted(function(x,y){ return x-y; });
    var spl = base.toSpliced(1, 1, 99);
    var wit = base['with'](0, 9);
    if (JSON.stringify(rev) !== '[2,1,3]') throw new Error('toReversed:' + rev);
    if (JSON.stringify(srt) !== '[1,2,3]') throw new Error('toSorted:' + srt);
    if (JSON.stringify(spl) !== '[3,99,2]') throw new Error('toSpliced:' + spl);
    if (JSON.stringify(wit) !== '[9,1,2]') throw new Error('with:' + wit);
    ok('Array toReversed / toSorted / toSpliced / with');
  } catch(e) { err('Array change methods', e); }

  // 11. Object.hasOwn
  try {
    var o = { x: 1 };
    if (!Object.hasOwn(o, 'x')) throw new Error('hasOwn x=false');
    if ( Object.hasOwn(o, 'y')) throw new Error('hasOwn y=true');
    ok('Object.hasOwn');
  } catch(e) { err('Object.hasOwn', e); }

  // 12. Async / await
  try {
    (async function() {
      var r = await Promise.resolve(123);
      return r + 1;
    })().then(function(v) {
      if (v !== 124) err('async/await', 'result=' + v);
      else           ok('async/await');
    }).catch(function(e) { err('async/await', e); });
  } catch(e) { err('async/await', e); }

  // 13. Generators
  try {
    function* gen() { yield 1; yield 2; yield 3; }
    var vals = Array.from(gen());
    if (JSON.stringify(vals) !== '[1,2,3]') throw new Error(vals);
    ok('generators');
  } catch(e) { err('generators', e); }

  // 14. WeakRef
  try {
    var wr = new WeakRef({ v: 5 });
    if (!wr.deref || wr.deref().v !== 5) throw new Error('deref failed');
    ok('WeakRef');
  } catch(e) { err('WeakRef', e); }

  // 15. Promise.allSettled
  try {
    Promise.allSettled([Promise.resolve(1), Promise.reject('x')])
      .then(function(rs) {
        if (rs[0].status !== 'fulfilled' || rs[1].status !== 'rejected')
          err('Promise.allSettled', JSON.stringify(rs));
        else
          ok('Promise.allSettled');
      });
  } catch(e) { err('Promise.allSettled', e); }

  // 16. structuredClone
  try {
    var orig = { a: [1, 2], b: { c: 3 } };
    var cloned = structuredClone(orig);
    if (cloned.b.c !== 3 || cloned === orig) throw new Error('clone failed');
    ok('structuredClone');
  } catch(e) { err('structuredClone', e); }

  // 17. queueMicrotask (just check no throw)
  try {
    queueMicrotask(function() {});
    ok('queueMicrotask (no throw)');
  } catch(e) { err('queueMicrotask', e); }

  // 18. DOM: createElement / appendChild / textContent / getElementById
  try {
    var div = document.createElement('div');
    div.textContent = 'jstest-probe';
    document.body.appendChild(div);
    var found = document.getElementById('results');
    if (!found) throw new Error('getElementById returned null');
    ok('DOM createElement / appendChild / getElementById');
  } catch(e) { err('DOM createElement/appendChild/getElementById', e); }

  // 19. setTimeout / clearTimeout (smoke test)
  try {
    var tid = setTimeout(function() {}, 500);
    clearTimeout(tid);
    ok('setTimeout / clearTimeout');
  } catch(e) { err('setTimeout / clearTimeout', e); }

  // 20. fetch() smoke test (expect a Promise object)
  try {
    var fret = fetch('about:blank');
    if (typeof fret.then !== 'function') throw new Error('not a Promise');
    ok('fetch() returns Promise');
  } catch(e) { err('fetch() returns Promise', e); }

  // 21. localStorage smoke test
  try {
    localStorage.setItem('__jst__', '1');
    var got = localStorage.getItem('__jst__');
    localStorage.removeItem('__jst__');
    if (got !== '1') throw new Error('got ' + got);
    ok('localStorage');
  } catch(e) { err('localStorage', e); }

  // 22. window.performance.now()
  try {
    var t = performance.now();
    if (typeof t !== 'number') throw new Error('type=' + typeof t);
    ok('performance.now()');
  } catch(e) { err('performance.now()', e); }

  // 23. requestAnimationFrame (smoke)
  try {
    var rafId = requestAnimationFrame(function() {});
    if (typeof rafId !== 'number' || rafId <= 0) throw new Error('id=' + rafId);
    cancelAnimationFrame(rafId);
    ok('requestAnimationFrame / cancelAnimationFrame');
  } catch(e) { err('requestAnimationFrame', e); }

  // 24. MutationObserver smoke test
  try {
    var mo = new MutationObserver(function(){});
    mo.observe(document.body, { childList: true });
    mo.disconnect();
    ok('MutationObserver');
  } catch(e) { err('MutationObserver', e); }

  // 25. IntersectionObserver smoke test
  try {
    var io = new IntersectionObserver(function(){});
    var dv = document.createElement('div');
    io.observe(dv);
    io.disconnect();
    ok('IntersectionObserver');
  } catch(e) { err('IntersectionObserver', e); }

  // Summary
  var summary = document.getElementById('summary');
  if (summary) summary.textContent = 'S1 (stage2): see serial log. S2 (stage1): ' + pass + ' pass, ' + fail + ' fail.';
  console.log('[JSTEST S2] ' + pass + ' pass, ' + fail + ' fail');
})();
`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>JSOS JS Test Suite</title>
<style>
  body { font-family: monospace; background: #111; color: #eee; padding: 16px; }
  h1 { color: #0f0; }
  ul { list-style: none; padding: 0; }
  #summary { margin-top: 12px; color: #ff0; }
</style>
</head><body>
<h1>JSOS JavaScript Test Suite</h1>
<p>Script 1 (class tests via stage-2): check serial log for S1 results.</p>
<ul id="results"></ul>
<div id="summary">Running...</div>
<script>${script1}</script>
<script>${script2}</script>
</body></html>`;
}
