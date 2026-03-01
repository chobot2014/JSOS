(function() {
  var _win = this;
  var _con = _win.console || { log: function(){} };
  var pass = 0, fail = 0;
  function ok(n)  { pass++; _con.log('[JSTEST PASS] ' + n); }
  function err(n,e){ fail++; _con.log('[JSTEST FAIL] ' + n + ': ' + e); }

  // 1. Class static initializer block \u2014\u2014 QJS rejects this inside with()
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

  // 5. Error subclass (class + extends \u2014 both rejected inside with())
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
