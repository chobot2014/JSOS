#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');
const esbuild = require('esbuild');

// Configuration
const SRC_DIR = path.join(__dirname, '..', 'src', 'os');
const BUILD_DIR = path.join(__dirname, '..', 'build');
const TEMP_DIR = path.join(BUILD_DIR, 'temp');
const OUTPUT_FILE = path.join(BUILD_DIR, 'bundle.js');

async function bundleWithBabelAndEsbuild() {
  console.log('Bundling TypeScript with Babel + esbuild for Duktape...');
  
  // Ensure directories exist
  if (!fs.existsSync(BUILD_DIR)) {
    fs.mkdirSync(BUILD_DIR, { recursive: true });
  }
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  // Find TypeScript files
  const tsFiles = fs.readdirSync(SRC_DIR).filter(file => file.endsWith('.ts'));
  
  if (tsFiles.length === 0) {
    console.error('No TypeScript files found in src/os directory');
    process.exit(1);
  }

  console.log(`   Found ${tsFiles.length} TypeScript files`);

  try {
    // Step 1: Transform TypeScript to JavaScript with Babel
    const transformedFiles = [];
    
    for (const tsFile of tsFiles) {
      console.log(`   Transforming ${tsFile}...`);
      
      const inputPath = path.join(SRC_DIR, tsFile);
      const outputPath = path.join(TEMP_DIR, tsFile.replace('.ts', '.js'));
      
      const sourceCode = fs.readFileSync(inputPath, 'utf8');
      
      const result = await babel.transformAsync(sourceCode, {
        filename: tsFile,
        presets: [
          ['@babel/preset-env', {
            targets: {
              esmodules: false // Target ES5 for maximum compatibility
            },
            modules: false, // Keep ES modules for esbuild to handle
            loose: true,
            forceAllTransforms: true,
            exclude: [] // Don't exclude anything - we need all transforms for Duktape
          }],
          '@babel/preset-typescript'
        ],
        plugins: [
          '@babel/plugin-transform-class-properties',
          '@babel/plugin-transform-private-methods',
          '@babel/plugin-transform-private-property-in-object',
          '@babel/plugin-transform-nullish-coalescing-operator',
          '@babel/plugin-transform-optional-chaining',
          '@babel/plugin-transform-arrow-functions',
          '@babel/plugin-transform-block-scoping',
          '@babel/plugin-transform-destructuring',
          '@babel/plugin-transform-spread',
          '@babel/plugin-transform-parameters',
          '@babel/plugin-transform-template-literals',
          '@babel/plugin-transform-shorthand-properties',
          '@babel/plugin-transform-computed-properties',
          '@babel/plugin-transform-object-super',
          '@babel/plugin-transform-classes',
          '@babel/plugin-transform-async-to-generator',
          '@babel/plugin-transform-regenerator',
          '@babel/plugin-transform-for-of',
          '@babel/plugin-transform-function-name',
          '@babel/plugin-transform-member-expression-literals',
          '@babel/plugin-transform-property-literals',
          '@babel/plugin-transform-reserved-words',
          '@babel/plugin-transform-sticky-regex',
          '@babel/plugin-transform-unicode-regex'
        ]
      });

      if (!result || !result.code) {
        throw new Error(`Failed to transform ${tsFile}`);
      }

      fs.writeFileSync(outputPath, result.code);
      transformedFiles.push(outputPath);
    }

    console.log('TypeScript to JavaScript transformation complete');

    // Step 2: Bundle with esbuild
    console.log('   Bundling with esbuild...');

    const mainFile = path.join(TEMP_DIR, 'main.js');
    if (!fs.existsSync(mainFile)) {
      console.error('main.js not found after transformation');
      process.exit(1);
    }

    // Duktape compatibility polyfills
    const duktapePolyfills = `
// Duktape compatibility layer and polyfills
(function() {
  'use strict';
  
  // In Duktape, the global object is accessible via 'this' in global scope
  // But it might be undefined, so we need to be careful
  var global;
  try {
    global = (typeof this !== 'undefined' && this !== null && this) ||
             (typeof globalThis !== 'undefined' && globalThis) ||
             (typeof global !== 'undefined' && global) ||
             (typeof window !== 'undefined' && window) ||
             (typeof self !== 'undefined' && self) ||
             {};
  } catch (e) {
    global = {};
  }
  
  // Ensure we have a valid global object
  if (!global || typeof global !== 'object') {
    global = {};
  }
  
  // Set up global references safely
  try {
    if (typeof globalThis === 'undefined') {
      global.globalThis = global;
    }
    if (typeof window === 'undefined') {
      global.window = global;
    }
    if (typeof self === 'undefined') {
      global.self = global;
    }
  } catch (e) {
    // Ignore if global is not writable
  }

  // Console polyfill for kernel integration
  if (typeof global.console === 'undefined') {
    global.console = {
      log: function() {
        var args = Array.prototype.slice.call(arguments);
        if (typeof kernel_log !== 'undefined') {
          kernel_log(args.join(' '));
        } else if (typeof print !== 'undefined') {
          print(args.join(' '));
        }
      },
      error: function() {
        var args = Array.prototype.slice.call(arguments);
        if (typeof kernel_log !== 'undefined') {
          kernel_log('ERROR: ' + args.join(' '));
        } else if (typeof print !== 'undefined') {
          print('ERROR: ' + args.join(' '));
        }
      },
      warn: function() {
        var args = Array.prototype.slice.call(arguments);
        if (typeof kernel_log !== 'undefined') {
          kernel_log('WARN: ' + args.join(' '));
        } else if (typeof print !== 'undefined') {
          print('WARN: ' + args.join(' '));
        }
      },
      clear: function() {
        if (typeof kernel_log !== 'undefined') {
          // Clear screen using ANSI escape codes
          kernel_log('\\u001b[2J\\u001b[H');
        }
      }
    };
  }
  
  // Essential polyfills - safely assign to global
  try {
    // Array polyfills
    if (!Array.isArray) {
      Array.isArray = function(arg) {
        return Object.prototype.toString.call(arg) === '[object Array]';
      };
    }

    if (!Array.prototype.forEach) {
      Array.prototype.forEach = function(callback, thisArg) {
        if (this == null) throw new TypeError('Array.prototype.forEach called on null or undefined');
        var T, k;
        var O = Object(this);
        var len = O.length >>> 0;
        if (typeof callback !== 'function') throw new TypeError(callback + ' is not a function');
        if (arguments.length > 1) T = thisArg;
        k = 0;
        while (k < len) {
          var kValue;
          if (k in O) {
            kValue = O[k];
            callback.call(T, kValue, k, O);
          }
          k++;
        }
      };
    }

    if (!Array.prototype.map) {
      Array.prototype.map = function(callback, thisArg) {
        if (this == null) throw new TypeError('Array.prototype.map called on null or undefined');
        var T, A, k;
        var O = Object(this);
        var len = O.length >>> 0;
        if (typeof callback !== 'function') throw new TypeError(callback + ' is not a function');
        if (arguments.length > 1) T = thisArg;
        A = new Array(len);
        k = 0;
        while (k < len) {
          var kValue, mappedValue;
          if (k in O) {
            kValue = O[k];
            mappedValue = callback.call(T, kValue, k, O);
            A[k] = mappedValue;
          }
          k++;
        }
        return A;
      };
    }

    if (!Array.prototype.filter) {
      Array.prototype.filter = function(callback, thisArg) {
        if (this == null) throw new TypeError('Array.prototype.filter called on null or undefined');
        var t = Object(this);
        var len = t.length >>> 0;
        if (typeof callback !== 'function') throw new TypeError(callback + ' is not a function');
        var res = [];
        var T = arguments.length > 1 ? thisArg : void 0;
        var k = 0;
        while (k < len) {
          if (k in t) {
            var kValue = t[k];
            if (callback.call(T, kValue, k, t)) {
              res.push(kValue);
            }
          }
          k++;
        }
        return res;
      };
    }

    if (!Array.prototype.reduce) {
      Array.prototype.reduce = function(callback, initialValue) {
        if (this == null) throw new TypeError('Array.prototype.reduce called on null or undefined');
        if (typeof callback !== 'function') throw new TypeError(callback + ' is not a function');
        var t = Object(this), len = t.length >>> 0, k = 0, value;
        if (arguments.length >= 2) {
          value = initialValue;
        } else {
          while (k < len && !(k in t)) k++;
          if (k >= len) throw new TypeError('Reduce of empty array with no initial value');
          value = t[k++];
        }
        for (; k < len; k++) {
          if (k in t) value = callback(value, t[k], k, t);
        }
        return value;
      };
    }

    if (!Array.prototype.indexOf) {
      Array.prototype.indexOf = function(searchElement, fromIndex) {
        var k;
        if (this == null) throw new TypeError('"this" is null or not defined');
        var o = Object(this);
        var len = o.length >>> 0;
        if (len === 0) return -1;
        var n = fromIndex | 0;
        if (n >= len) return -1;
        k = Math.max(n >= 0 ? n : len - Math.abs(n), 0);
        while (k < len) {
          if (k in o && o[k] === searchElement) return k;
          k++;
        }
        return -1;
      };
    }

    // Object polyfills
    if (!Object.keys) {
      Object.keys = function(obj) {
        var keys = [];
        for (var key in obj) {
          if (obj.hasOwnProperty(key)) {
            keys.push(key);
          }
        }
        return keys;
      };
    }

    if (!Object.assign) {
      Object.assign = function(target) {
        if (target == null) throw new TypeError('Cannot convert undefined or null to object');
        var to = Object(target);
        for (var index = 1; index < arguments.length; index++) {
          var nextSource = arguments[index];
          if (nextSource != null) {
            for (var nextKey in nextSource) {
              if (Object.prototype.hasOwnProperty.call(nextSource, nextKey)) {
                to[nextKey] = nextSource[nextKey];
              }
            }
          }
        }
        return to;
      };
    }

    if (!Object.create) {
      Object.create = function(proto, propertiesObject) {
        if (typeof proto !== 'object' && typeof proto !== 'function') {
          throw new TypeError('Object prototype may only be an Object or null');
        }
        function F() {}
        F.prototype = proto;
        var obj = new F();
        if (propertiesObject !== undefined) {
          Object.defineProperties(obj, propertiesObject);
        }
        return obj;
      };
    }

    // String polyfills
    if (!String.prototype.includes) {
      String.prototype.includes = function(search, start) {
        if (typeof start !== 'number') start = 0;
        if (start + search.length > this.length) return false;
        return this.indexOf(search, start) !== -1;
      };
    }

    if (!String.prototype.startsWith) {
      String.prototype.startsWith = function(searchString, position) {
        position = position || 0;
        return this.substr(position, searchString.length) === searchString;
      };
    }

    if (!String.prototype.endsWith) {
      String.prototype.endsWith = function(searchString, position) {
        var subjectString = this.toString();
        if (typeof position !== 'number' || !isFinite(position) || Math.floor(position) !== position || position > subjectString.length) {
          position = subjectString.length;
        }
        position -= searchString.length;
        var lastIndex = subjectString.indexOf(searchString, position);
        return lastIndex !== -1 && lastIndex === position;
      };
    }

    if (!String.prototype.trim) {
      String.prototype.trim = function() {
        return this.replace(/^[\s\uFEFF\xA0]+|[\s\uFEFF\xA0]+$/g, '');
      };
    }

    // Function polyfills
    if (!Function.prototype.bind) {
      Function.prototype.bind = function(oThis) {
        if (typeof this !== 'function') throw new TypeError('Function.prototype.bind - what is trying to be bound is not callable');
        var aArgs = Array.prototype.slice.call(arguments, 1),
            fToBind = this,
            fNOP = function() {},
            fBound = function() {
              return fToBind.apply(this instanceof fNOP && oThis ? this : oThis,
                                   aArgs.concat(Array.prototype.slice.call(arguments)));
            };
        fNOP.prototype = this.prototype;
        fBound.prototype = new fNOP();
        return fBound;
      };
    }

    // Date polyfills
    if (!Date.now) {
      Date.now = function() { return new Date().getTime(); };
    }

    // JSON polyfill (basic)
    if (typeof JSON === 'undefined') {
      global.JSON = {
        parse: function(text) {
          return eval('(' + text + ')');
        },
        stringify: function(obj) {
          var t = typeof obj;
          if (t !== "object" || obj === null) {
            if (t === "string") return '"' + obj + '"';
            return String(obj);
          }
          var json = [], arr = (obj && obj.constructor === Array);
          for (var k in obj) {
            if (obj.hasOwnProperty(k)) {
              var v = obj[k]; t = typeof v;
              if (t === "string") v = '"' + v + '"';
              else if (t === "object" && v !== null) v = this.stringify(v);
              json.push((arr ? "" : '"' + k + '":') + String(v));
            }
          }
          return (arr ? "[" : "{") + String(json) + (arr ? "]" : "}");
        }
      };
    }

    // Symbol polyfill (basic)
    if (typeof Symbol === 'undefined') {
      global.Symbol = function Symbol(description) {
        this.description = description;
        this.toString = function() { return 'Symbol(' + this.description + ')'; };
      };
      global.Symbol.iterator = new Symbol('iterator');
      global.Symbol.toPrimitive = new Symbol('toPrimitive');
    }

    // RegExp polyfills
    if (!RegExp.prototype.test) {
      RegExp.prototype.test = function(string) {
        return this.exec(string) !== null;
      };
    }

    // Number polyfills
    if (!Number.isNaN) {
      Number.isNaN = function(value) {
        return value !== value;
      };
    }

    if (!Number.isFinite) {
      Number.isFinite = function(value) {
        return typeof value === 'number' && isFinite(value);
      };
    }

    // Math polyfills
    if (!Math.trunc) {
      Math.trunc = function(x) {
        return x < 0 ? Math.ceil(x) : Math.floor(x);
      };
    }

    if (!Math.sign) {
      Math.sign = function(x) {
        return ((x > 0) - (x < 0)) || +x;
      };
    }

    // Error polyfills
    if (typeof Error === 'undefined') {
      global.Error = function Error(message) {
        this.name = 'Error';
        this.message = message || '';
      };
      global.Error.prototype = {
        toString: function() {
          return this.name + ': ' + this.message;
        }
      };
    }

    if (typeof TypeError === 'undefined') {
      global.TypeError = function TypeError(message) {
        this.name = 'TypeError';
        this.message = message || '';
      };
      global.TypeError.prototype = new Error();
      global.TypeError.prototype.constructor = global.TypeError;
    }
    if (!Date.now) {
      Date.now = function() { return new Date().getTime(); };
    }
  } catch (e) {}
  
  try {
    if (typeof global.Set === 'undefined') {
      global.Set = function Set(iterable) {
        this._items = [];
        if (iterable) {
          for (var i = 0; i < iterable.length; i++) {
            this.add(iterable[i]);
          }
        }
      };
      global.Set.prototype.add = function(value) {
        if (this._items.indexOf(value) === -1) {
          this._items.push(value);
        }
        return this;
      };
      global.Set.prototype.has = function(value) {
        return this._items.indexOf(value) !== -1;
      };
      global.Set.prototype.delete = function(value) {
        var index = this._items.indexOf(value);
        if (index !== -1) {
          this._items.splice(index, 1);
          return true;
        }
        return false;
      };
      global.Set.prototype.clear = function() {
        this._items = [];
      };
      Object.defineProperty(global.Set.prototype, 'size', {
        get: function() { return this._items.length; }
      });
    }
  } catch (e) {}
  
  try {
    if (typeof global.Map === 'undefined') {
      global.Map = function Map() {
        this._keys = [];
        this._values = [];
      };
      global.Map.prototype.set = function(key, value) {
        var index = this._keys.indexOf(key);
        if (index === -1) {
          this._keys.push(key);
          this._values.push(value);
        } else {
          this._values[index] = value;
        }
        return this;
      };
      global.Map.prototype.get = function(key) {
        var index = this._keys.indexOf(key);
        return index !== -1 ? this._values[index] : undefined;
      };
      global.Map.prototype.has = function(key) {
        return this._keys.indexOf(key) !== -1;
      };
      global.Map.prototype.delete = function(key) {
        var index = this._keys.indexOf(key);
        if (index !== -1) {
          this._keys.splice(index, 1);
          this._values.splice(index, 1);
          return true;
        }
        return false;
      };
      global.Map.prototype.clear = function() {
        this._keys = [];
        this._values = [];
      };
      Object.defineProperty(global.Map.prototype, 'size', {
        get: function() { return this._keys.length; }
      });
    }
  } catch (e) {}
  
  // Basic Promise polyfill
  try {
    if (typeof Promise === 'undefined') {
      global.Promise = function Promise(executor) {
        var self = this;
        self.state = 'pending';
        self.value = undefined;
        self.handlers = [];
        
        function resolve(value) {
          if (self.state === 'pending') {
            self.state = 'fulfilled';
            self.value = value;
            self.handlers.forEach(handle);
          }
        }
        
        function reject(reason) {
          if (self.state === 'pending') {
            self.state = 'rejected';
            self.value = reason;
            self.handlers.forEach(handle);
          }
        }
        
        function handle(handler) {
          if (self.state === 'pending') {
            self.handlers.push(handler);
          } else {
            if (self.state === 'fulfilled' && handler.onFulfilled) {
              handler.onFulfilled(self.value);
            }
            if (self.state === 'rejected' && handler.onRejected) {
              handler.onRejected(self.value);
            }
          }
        }
        
        self.then = function(onFulfilled, onRejected) {
          return new Promise(function(resolve, reject) {
            handle({
              onFulfilled: function(value) {
                try {
                  resolve(onFulfilled ? onFulfilled(value) : value);
                } catch (ex) {
                  reject(ex);
                }
              },
              onRejected: function(reason) {
                try {
                  resolve(onRejected ? onRejected(reason) : reason);
                } catch (ex) {
                  reject(ex);
                }
              }
            });
          });
        };
        
        self.catch = function(onRejected) {
          return self.then(null, onRejected);
        };
        
        try {
          executor(resolve, reject);
        } catch (ex) {
          reject(ex);
        }
      };
      
      global.Promise.resolve = function(value) {
        return new Promise(function(resolve) {
          resolve(value);
        });
      };
      
      global.Promise.reject = function(reason) {
        return new Promise(function(resolve, reject) {
          reject(reason);
        });
      };
      
      global.Promise.all = function(promises) {
        return new Promise(function(resolve, reject) {
          var results = [];
          var completed = 0;
          var total = promises.length;
          
          if (total === 0) {
            resolve(results);
            return;
          }
          
          function checkDone() {
            completed++;
            if (completed === total) {
              resolve(results);
            }
          }
          
          for (var i = 0; i < total; i++) {
            (function(index) {
              Promise.resolve(promises[index]).then(function(value) {
                results[index] = value;
                checkDone();
              }, reject);
            })(i);
          }
        });
      };
      
      global.Promise.race = function(promises) {
        return new Promise(function(resolve, reject) {
          for (var i = 0; i < promises.length; i++) {
            Promise.resolve(promises[i]).then(resolve, reject);
          }
        });
      };
    }
  } catch (e) {}
  
  // Object.assign polyfill
  try {
    if (typeof Object.assign === 'undefined') {
      Object.assign = function(target) {
        if (target == null) {
          throw new TypeError('Cannot convert undefined or null to object');
        }
        
        var to = Object(target);
        
        for (var index = 1; index < arguments.length; index++) {
          var nextSource = arguments[index];
          
          if (nextSource != null) {
            for (var nextKey in nextSource) {
              if (Object.prototype.hasOwnProperty.call(nextSource, nextKey)) {
                to[nextKey] = nextSource[nextKey];
              }
            }
          }
        }
        return to;
      };
    }
  } catch (e) {}
  
  // Array.prototype.flat polyfill
  try {
    if (typeof Array.prototype.flat === 'undefined') {
      Array.prototype.flat = function(depth) {
        var d = depth || 1;
        var result = [];
        
        for (var i = 0; i < this.length; i++) {
          if (Array.isArray(this[i]) && d > 0) {
            result = result.concat(this[i].flat(d - 1));
          } else {
            result.push(this[i]);
          }
        }
        
        return result;
      };
    }
  } catch (e) {}
  
  // Array.prototype.includes polyfill
  try {
    if (typeof Array.prototype.includes === 'undefined') {
      Array.prototype.includes = function(searchElement, fromIndex) {
        var start = fromIndex || 0;
        for (var i = start; i < this.length; i++) {
          if (this[i] === searchElement) {
            return true;
          }
        }
        return false;
      };
    }
  } catch (e) {}
  
  // String.prototype.includes polyfill
  try {
    if (typeof String.prototype.includes === 'undefined') {
      String.prototype.includes = function(searchString, position) {
        return this.indexOf(searchString, position) !== -1;
      };
    }
  } catch (e) {}
  
  // Symbol basic polyfill (minimal)
  try {
    if (typeof Symbol === 'undefined') {
      global.Symbol = function Symbol(description) {
        return 'Symbol(' + (description || '') + ')';
      };
      global.Symbol.iterator = 'Symbol(iterator)';
    }
  } catch (e) {}
  
  // Additional IE11-level polyfills
  
  // Array.isArray polyfill
  try {
    if (typeof Array.isArray === 'undefined') {
      Array.isArray = function(arg) {
        return Object.prototype.toString.call(arg) === '[object Array]';
      };
    }
  } catch (e) {}
  
  // Object.keys polyfill
  try {
    if (typeof Object.keys === 'undefined') {
      Object.keys = function(obj) {
        var keys = [];
        for (var key in obj) {
          if (obj.hasOwnProperty(key)) {
            keys.push(key);
          }
        }
        return keys;
      };
    }
  } catch (e) {}
  
  // Object.create polyfill
  try {
    if (typeof Object.create === 'undefined') {
      Object.create = function(proto, propertiesObject) {
        if (typeof proto !== 'object' && typeof proto !== 'function') {
          throw new TypeError('Object prototype may only be an Object or null');
        }
        function F() {}
        F.prototype = proto;
        var obj = new F();
        if (propertiesObject !== undefined) {
          Object.defineProperties(obj, propertiesObject);
        }
        return obj;
      };
    }
  } catch (e) {}
  
  // Function.prototype.bind polyfill
  try {
    if (typeof Function.prototype.bind === 'undefined') {
      Function.prototype.bind = function(oThis) {
        if (typeof this !== 'function') {
          throw new TypeError('Function.prototype.bind - what is trying to be bound is not callable');
        }
        var aArgs = Array.prototype.slice.call(arguments, 1);
        var fToBind = this;
        var fNOP = function() {};
        var fBound = function() {
          return fToBind.apply(this instanceof fNOP && oThis ? this : oThis,
                               aArgs.concat(Array.prototype.slice.call(arguments)));
        };
        fNOP.prototype = this.prototype;
        fBound.prototype = new fNOP();
        return fBound;
      };
    }
  } catch (e) {}
  
  // String.prototype.trim polyfill
  try {
    if (typeof String.prototype.trim === 'undefined') {
      String.prototype.trim = function() {
        return this.replace(/^[\s\uFEFF\xA0]+|[\s\uFEFF\xA0]+$/g, '');
      };
    }
  } catch (e) {}
  
  // Array.prototype.indexOf polyfill
  try {
    if (typeof Array.prototype.indexOf === 'undefined') {
      Array.prototype.indexOf = function(searchElement, fromIndex) {
        var k;
        if (this == null) {
          throw new TypeError('"this" is null or not defined');
        }
        var o = Object(this);
        var len = o.length >>> 0;
        if (len === 0) {
          return -1;
        }
        var n = fromIndex | 0;
        if (n >= len) {
          return -1;
        }
        k = Math.max(n >= 0 ? n : len - Math.abs(n), 0);
        while (k < len) {
          if (k in o && o[k] === searchElement) {
            return k;
          }
          k++;
        }
        return -1;
      };
    }
  } catch (e) {}
  
  // Array.prototype.forEach polyfill
  try {
    if (typeof Array.prototype.forEach === 'undefined') {
      Array.prototype.forEach = function(callback, thisArg) {
        if (this == null) {
          throw new TypeError('this is null or not defined');
        }
        if (typeof callback !== 'function') {
          throw new TypeError(callback + ' is not a function');
        }
        var O = Object(this);
        var len = O.length >>> 0;
        var k = 0;
        while (k < len) {
          if (k in O) {
            callback.call(thisArg, O[k], k, O);
          }
          k++;
        }
      };
    }
  } catch (e) {}
  
  // Array.prototype.filter polyfill
  try {
    if (typeof Array.prototype.filter === 'undefined') {
      Array.prototype.filter = function(fun) {
        if (this === void 0 || this === null) {
          throw new TypeError();
        }
        var t = Object(this);
        var len = t.length >>> 0;
        if (typeof fun !== 'function') {
          throw new TypeError();
        }
        var res = [];
        var thisArg = arguments.length >= 2 ? arguments[1] : void 0;
        for (var i = 0; i < len; i++) {
          if (i in t) {
            var val = t[i];
            if (fun.call(thisArg, val, i, t)) {
              res.push(val);
            }
          }
        }
        return res;
      };
    }
  } catch (e) {}
  
  // Array.prototype.map polyfill
  try {
    if (typeof Array.prototype.map === 'undefined') {
      Array.prototype.map = function(callback, thisArg) {
        var T, A, k;
        if (this == null) {
          throw new TypeError('this is null or not defined');
        }
        var O = Object(this);
        var len = O.length >>> 0;
        if (typeof callback !== 'function') {
          throw new TypeError(callback + ' is not a function');
        }
        if (arguments.length > 1) {
          T = thisArg;
        }
        A = new Array(len);
        k = 0;
        while (k < len) {
          var kValue, mappedValue;
          if (k in O) {
            kValue = O[k];
            mappedValue = callback.call(T, kValue, k, O);
            A[k] = mappedValue;
          }
          k++;
        }
        return A;
      };
    }
  } catch (e) {}
  
  // Array.prototype.reduce polyfill
  try {
    if (typeof Array.prototype.reduce === 'undefined') {
      Array.prototype.reduce = function(callback) {
        if (this === void 0 || this === null) {
          throw new TypeError('Array.prototype.reduce called on null or undefined');
        }
        if (typeof callback !== 'function') {
          throw new TypeError(callback + ' is not a function');
        }
        var t = Object(this), len = t.length >>> 0, k = 0, value;
        if (arguments.length >= 2) {
          value = arguments[1];
        } else {
          while (k < len && !(k in t)) {
            k++;
          }
          if (k >= len) {
            throw new TypeError('Reduce of empty array with no initial value');
          }
          value = t[k++];
        }
        for (; k < len; k++) {
          if (k in t) {
            value = callback(value, t[k], k, t);
          }
        }
        return value;
      };
    }
  } catch (e) {}
  
  // Array.prototype.some polyfill
  try {
    if (typeof Array.prototype.some === 'undefined') {
      Array.prototype.some = function(fun) {
        if (this == null) {
          throw new TypeError('Array.prototype.some called on null or undefined');
        }
        if (typeof fun !== 'function') {
          throw new TypeError();
        }
        var t = Object(this);
        var len = t.length >>> 0;
        var thisArg = arguments.length >= 2 ? arguments[1] : void 0;
        for (var i = 0; i < len; i++) {
          if (i in t && fun.call(thisArg, t[i], i, t)) {
            return true;
          }
        }
        return false;
      };
    }
  } catch (e) {}
  
  // Array.prototype.every polyfill
  try {
    if (typeof Array.prototype.every === 'undefined') {
      Array.prototype.every = function(fun) {
        if (this == null) {
          throw new TypeError('Array.prototype.every called on null or undefined');
        }
        if (typeof fun !== 'function') {
          throw new TypeError();
        }
        var t = Object(this);
        var len = t.length >>> 0;
        var thisArg = arguments.length >= 2 ? arguments[1] : void 0;
        for (var i = 0; i < len; i++) {
          if (i in t && !fun.call(thisArg, t[i], i, t)) {
            return false;
          }
        }
        return true;
      };
    }
  } catch (e) {}
  
  // Array.prototype.find polyfill
  try {
    if (typeof Array.prototype.find === 'undefined') {
      Array.prototype.find = function(predicate) {
        if (this == null) {
          throw new TypeError('Array.prototype.find called on null or undefined');
        }
        if (typeof predicate !== 'function') {
          throw new TypeError('predicate must be a function');
        }
        var list = Object(this);
        var length = list.length >>> 0;
        var thisArg = arguments[1];
        var value;
        
        for (var i = 0; i < length; i++) {
          value = list[i];
          if (predicate.call(thisArg, value, i, list)) {
            return value;
          }
        }
        return undefined;
      };
    }
  } catch (e) {}
  
  // Array.prototype.findIndex polyfill
  try {
    if (typeof Array.prototype.findIndex === 'undefined') {
      Array.prototype.findIndex = function(predicate) {
        if (this == null) {
          throw new TypeError('Array.prototype.findIndex called on null or undefined');
        }
        if (typeof predicate !== 'function') {
          throw new TypeError('predicate must be a function');
        }
        var list = Object(this);
        var length = list.length >>> 0;
        var thisArg = arguments[1];
        var value;
        
        for (var i = 0; i < length; i++) {
          value = list[i];
          if (predicate.call(thisArg, value, i, list)) {
            return i;
          }
        }
        return -1;
      };
    }
  } catch (e) {}
  
  // String.prototype.startsWith polyfill
  try {
    if (typeof String.prototype.startsWith === 'undefined') {
      String.prototype.startsWith = function(searchString, position) {
        position = position || 0;
        return this.substr(position, searchString.length) === searchString;
      };
    }
  } catch (e) {}
  
  // String.prototype.endsWith polyfill
  try {
    if (typeof String.prototype.endsWith === 'undefined') {
      String.prototype.endsWith = function(searchString, position) {
        var subjectString = this.toString();
        if (typeof position !== 'number' || !isFinite(position) || Math.floor(position) !== position || position > subjectString.length) {
          position = subjectString.length;
        }
        position -= searchString.length;
        var lastIndex = subjectString.indexOf(searchString, position);
        return lastIndex !== -1 && lastIndex === position;
      };
    }
  } catch (e) {}
  
  // String.prototype.repeat polyfill
  try {
    if (typeof String.prototype.repeat === 'undefined') {
      String.prototype.repeat = function(count) {
        if (this == null) {
          throw new TypeError('can\'t convert ' + this + ' to object');
        }
        var str = '' + this;
        count = +count;
        if (count != count) {
          count = 0;
        }
        if (count < 0) {
          throw new RangeError('repeat count must be non-negative');
        }
        if (count == Infinity) {
          throw new RangeError('repeat count must be less than infinity');
        }
        count = Math.floor(count);
        if (str.length == 0 || count == 0) {
          return '';
        }
        if (str.length * count >= 1 << 28) {
          throw new RangeError('repeat count must not overflow maximum string size');
        }
        var rpt = '';
        for (;;) {
          if ((count & 1) == 1) {
            rpt += str;
          }
          count >>>= 1;
          if (count == 0) {
            break;
          }
          str += str;
        }
        return rpt;
      };
    }
  } catch (e) {}
  
  // Number.isNaN polyfill
  try {
    if (typeof Number.isNaN === 'undefined') {
      Number.isNaN = function(value) {
        return value !== value;
      };
    }
  } catch (e) {}
  
  // Number.isFinite polyfill
  try {
    if (typeof Number.isFinite === 'undefined') {
      Number.isFinite = function(value) {
        return typeof value === 'number' && isFinite(value);
      };
    }
  } catch (e) {}
  
  // Math methods polyfills
  try {
    if (typeof Math.trunc === 'undefined') {
      Math.trunc = function(x) {
        return x < 0 ? Math.ceil(x) : Math.floor(x);
      };
    }
  } catch (e) {}
  
  try {
    if (typeof Math.sign === 'undefined') {
      Math.sign = function(x) {
        x = +x;
        if (x === 0 || isNaN(x)) {
          return x;
        }
        return x > 0 ? 1 : -1;
      };
    }
  } catch (e) {}
  
  // JSON polyfill (basic)
  try {
    if (typeof JSON === 'undefined') {
      global.JSON = {
        parse: function(text) {
          return eval('(' + text + ')');
        },
        stringify: function(obj) {
          var type = typeof obj;
          if (type === 'string') {
            return '"' + obj.replace(/"/g, '\\"') + '"';
          }
          if (type === 'number' || type === 'boolean') {
            return obj.toString();
          }
          if (obj === null) {
            return 'null';
          }
          if (Array.isArray(obj)) {
            return '[' + obj.map(function(item) { return JSON.stringify(item); }).join(',') + ']';
          }
          if (type === 'object') {
            var pairs = [];
            for (var key in obj) {
              if (obj.hasOwnProperty(key)) {
                pairs.push('"' + key + '":' + JSON.stringify(obj[key]));
              }
            }
            return '{' + pairs.join(',') + '}';
          }
          return 'null';
        }
      };
    }
  } catch (e) {}
  
  // RegExp methods polyfills
  try {
    if (typeof RegExp.prototype.test === 'undefined') {
      RegExp.prototype.test = function(string) {
        return this.exec(string) !== null;
      };
    }
  } catch (e) {}
  
  // Regenerator runtime for async/await support
  try {
    // Basic regenerator runtime polyfill
    if (typeof regeneratorRuntime === 'undefined') {
      global.regeneratorRuntime = (function() {
        function AsyncIterator(generator) {
          function invoke(method, arg, resolve, reject) {
            var record = { method: method, arg: arg, resolve: resolve, reject: reject, next: null };
            var prev = this._invoke;
            this._invoke = record;
            if (prev) {
              prev.next = record;
            } else {
              this._invoke = record;
            }
          }
          
          function enqueue(self, state) {
            function callInvokeWithMethodAndArg() {
              return new Promise(function(resolve, reject) {
                invoke.call(self, state, undefined, resolve, reject);
              });
            }
            return self._invoke = { method: state, next: null };
          }
          
          this._invoke = enqueue(this, 'start');
        }
        
        AsyncIterator.prototype = {
          constructor: AsyncIterator,
          next: function(arg) {
            var self = this;
            return new Promise(function(resolve, reject) {
              invoke.call(self, 'next', arg, resolve, reject);
            });
          },
          throw: function(arg) {
            var self = this;
            return new Promise(function(resolve, reject) {
              invoke.call(self, 'throw', arg, resolve, reject);
            });
          },
          return: function(arg) {
            var self = this;
            return new Promise(function(resolve, reject) {
              invoke.call(self, 'return', arg, resolve, reject);
            });
          }
        };
        
        function Generator() {}
        Generator.prototype = {
          constructor: Generator,
          next: function(arg) {
            return this._invoke('next', arg);
          },
          throw: function(arg) {
            return this._invoke('throw', arg);
          },
          return: function(arg) {
            return this._invoke('return', arg);
          }
        };
        
        Generator.prototype[Symbol.iterator] = function() {
          return this;
        };
        
        Generator.prototype.toString = function() {
          return '[object Generator]';
        };
        
        function pushTryEntry(locs) {
          var entry = { tryLoc: locs[0] };
          if (1 in locs) {
            entry.catchLoc = locs[1];
          }
          if (2 in locs) {
            entry.finallyLoc = locs[2];
            entry.afterLoc = locs[3];
          }
          this.tryEntries.push(entry);
        }
        
        function resetTryEntry(entry) {
          var record = entry.completion || {};
          record.type = 'normal';
          delete record.arg;
          entry.completion = record;
        }
        
        function Context(tryLocsList) {
          this.tryEntries = [{ tryLoc: 'root' }];
          tryLocsList.forEach(pushTryEntry, this);
          this.reset(true);
        }
        
        Context.prototype = {
          constructor: Context,
          reset: function(skipTempReset) {
            this.prev = 0;
            this.next = 0;
            this.sent = undefined;
            this.done = false;
            this.routine = undefined;
            this.tryEntries.forEach(resetTryEntry);
            if (!skipTempReset) {
              for (var name in this) {
                if (name.charAt(0) === 't' && this[name] !== undefined) {
                  this[name] = undefined;
                }
              }
            }
          },
          stop: function() {
            this.done = true;
            var rootEntry = this.tryEntries[0];
            var rootRecord = rootEntry.completion;
            if (rootRecord.type === 'throw') {
              throw rootRecord.arg;
            }
            return this.routine;
          },
          abrupt: function(type, arg) {
            for (var i = this.tryEntries.length - 1; i >= 0; i--) {
              var entry = this.tryEntries[i];
              if (entry.tryLoc <= this.prev && hasOwn.call(entry, 'finallyLoc') && entry.finallyLoc !== undefined) {
                this.prev = entry.finallyLoc;
                return type === 'break' || type === 'continue' ? this : { value: arg, done: true };
              }
            }
            return { value: arg, done: type === 'return' };
          },
          wrap: function(innerFn, outerFn, self, tryLocsList) {
            var context = new Context(tryLocsList);
            return {
              next: function(arg) {
                context.sent = arg;
                return context.dispatchException = context.dispatch = function(handle, arg) {
                  if (handle.type === 'normal') {
                    context.done = true;
                    return { value: arg, done: context.done };
                  } else {
                    return handle;
                  }
                };
              }
            };
          }
        };
        
        return {
          wrap: function(fn) {
            return function() {
              return new AsyncIterator(fn.apply(this, arguments));
            };
          },
          mark: function(fn) {
            if (Object.setPrototypeOf) {
              Object.setPrototypeOf(fn, Generator.prototype);
            } else {
              fn.__proto__ = Generator.prototype;
            }
            fn.prototype = Object.create(Generator.prototype);
            return fn;
          },
          awrap: function(value) {
            return { __await: value };
          },
          aslice: function(iter) {
            return { __iterator: iter };
          },
          aclose: function(iter) {
            return { __close: iter };
          },
          isGeneratorFunction: function(genFun) {
            var ctor = typeof genFun === 'function' && genFun.constructor;
            return ctor ? ctor.name === 'GeneratorFunction' : false;
          },
          mark: function(genFun) {
            return Object.setPrototypeOf ? Object.setPrototypeOf(genFun, Generator) : genFun.__proto__ = Generator;
          },
          AsyncIterator: AsyncIterator,
          Generator: Generator
        };
      })();
    }
  } catch (e) {}
  
  // WeakMap basic polyfill (very basic, not spec compliant)
  try {
    if (typeof global.WeakMap === 'undefined') {
      global.WeakMap = function WeakMap() {
        this._keys = [];
        this._values = [];
        this._uids = {};
        this._uid = 0;
      };
      global.WeakMap.prototype.set = function(key, value) {
        var uid = key;
        if (typeof key !== 'object' || key === null) {
          throw new TypeError('Invalid value used as weak map key');
        }
        if (!(uid in this._uids)) {
          this._uids[uid] = ++this._uid;
          this._keys.push(uid);
          this._values.push(value);
        } else {
          var index = this._keys.indexOf(uid);
          this._values[index] = value;
        }
        return this;
      };
      global.WeakMap.prototype.get = function(key) {
        var uid = key;
        if (typeof key !== 'object' || key === null) {
          return undefined;
        }
        var index = this._keys.indexOf(uid);
        return index !== -1 ? this._values[index] : undefined;
      };
      global.WeakMap.prototype.has = function(key) {
        var uid = key;
        if (typeof key !== 'object' || key === null) {
          return false;
        }
        return this._keys.indexOf(uid) !== -1;
      };
      global.WeakMap.prototype.delete = function(key) {
        var uid = key;
        if (typeof key !== 'object' || key === null) {
          return false;
        }
        var index = this._keys.indexOf(uid);
        if (index !== -1) {
          this._keys.splice(index, 1);
          this._values.splice(index, 1);
          delete this._uids[uid];
          return true;
        }
        return false;
      };
    }
  } catch (e) {}
  
})();`;

    const result = await esbuild.build({
      entryPoints: [mainFile],
      bundle: true,
      outfile: OUTPUT_FILE + '.temp',
      format: 'iife', // Use IIFE format for Duktape compatibility
      target: 'es2015', // Use ES2015 as intermediate, then post-process
      platform: 'neutral',
      minify: false,
      sourcemap: false,
      globalName: 'JSOS_MODULE', // Give it a global name
      banner: {
        js: duktapePolyfills
      },
      footer: {
        js: `
// Start the operating system
(function() {
  try {
    if (typeof main === 'function') {
      console.log('Starting with global main...');
      var result = main();
      if (result && typeof result.then === 'function') {
        result.then(function() {
          console.log('System started successfully');
        }).catch(function(error) {
          console.error('Fatal error:', error);
        });
      }
    } else {
      console.error('ERROR: No main function found');
    }
  } catch (error) {
    console.error('Startup error:', error);
  }
})();
`
      }
    });

    if (result.errors.length > 0) {
      console.error('esbuild errors:');
      result.errors.forEach(error => console.error(error));
      process.exit(1);
    }

    if (result.warnings.length > 0) {
      console.warn('esbuild warnings:');
      result.warnings.forEach(warning => console.warn(warning));
    }

    // Step 3: Final ES5 compatibility pass
    let bundledCode = fs.readFileSync(OUTPUT_FILE + '.temp', 'utf8');
    
    // Additional post-processing for strict ES5 compatibility
    bundledCode = bundledCode.replace(/\bconst\b/g, 'var');
    bundledCode = bundledCode.replace(/\blet\b/g, 'var');
    
    // Write final output
    fs.writeFileSync(OUTPUT_FILE, bundledCode);
    
    // Clean up temp files
    fs.unlinkSync(OUTPUT_FILE + '.temp');
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });

    console.log('Successfully bundled with Babel + esbuild!');
    console.log(`   Output: ${OUTPUT_FILE}`);
    console.log(`   Size:   ${Math.round(bundledCode.length / 1024 * 100) / 100}KB`);

  } catch (error) {
    console.error('Bundling failed:', error);
    process.exit(1);
  }
}

// Run the bundler
bundleWithBabelAndEsbuild().catch(error => {
  console.error('Bundling failed:', error);
  process.exit(1);
});
