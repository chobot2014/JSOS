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
  console.log('🔨 Bundling TypeScript with Babel + esbuild for Duktape...');
  
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
    console.error('❌ No TypeScript files found in src/os directory');
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
              ie: '11'
            },
            modules: false, // Keep ES modules for esbuild to handle
            loose: true,
            forceAllTransforms: true,
            exclude: ['transform-regenerator']
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
          '@babel/plugin-transform-shorthand-properties'
        ]
      });

      if (!result || !result.code) {
        throw new Error(`Failed to transform ${tsFile}`);
      }

      fs.writeFileSync(outputPath, result.code);
      transformedFiles.push(outputPath);
    }

    console.log('✅ TypeScript to JavaScript transformation complete');

    // Step 2: Bundle with esbuild
    console.log('   Bundling with esbuild...');

    const mainFile = path.join(TEMP_DIR, 'main.js');
    if (!fs.existsSync(mainFile)) {
      console.error('❌ main.js not found after transformation');
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
  
})();`;

    const result = await esbuild.build({
      entryPoints: [mainFile],
      bundle: true,
      outfile: OUTPUT_FILE + '.temp',
      format: 'iife',
      target: 'es2015', // Use ES2015 as intermediate, then post-process
      platform: 'neutral',
      minify: false,
      sourcemap: false,
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
      console.error('❌ esbuild errors:');
      result.errors.forEach(error => console.error(error));
      process.exit(1);
    }

    if (result.warnings.length > 0) {
      console.warn('⚠️ esbuild warnings:');
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

    console.log('✅ Successfully bundled with Babel + esbuild!');
    console.log(`   Output: ${OUTPUT_FILE}`);
    console.log(`   Size:   ${Math.round(bundledCode.length / 1024 * 100) / 100}KB`);

  } catch (error) {
    console.error('❌ Bundling failed:', error);
    process.exit(1);
  }
}

// Run the bundler
bundleWithBabelAndEsbuild().catch(error => {
  console.error('❌ Bundling failed:', error);
  process.exit(1);
});
