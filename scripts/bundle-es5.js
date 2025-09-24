#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Configuration
const INPUT_DIR = path.join(__dirname, '..', 'build', 'js');
const OUTPUT_DIR = path.join(__dirname, '..', 'build');
const BUNDLE_OUTPUT = path.join(OUTPUT_DIR, 'bundle.js');

function bundleFiles() {
  console.log('🔨 Bundling TypeScript ES5 output for Duktape...');
  
  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Read all JS files from input directory
  const jsFiles = fs.readdirSync(INPUT_DIR).filter(file => file.endsWith('.js'));
  
  if (jsFiles.length === 0) {
    console.error('❌ No JavaScript files found in build directory. Run TypeScript compilation first.');
    process.exit(1);
  }

  // ES5 polyfills and Duktape compatibility layer
  const polyfills = `
// ES5 Polyfills and Duktape compatibility layer
(function() {
  'use strict';
  
  var global = (function() {
    if (typeof global !== 'undefined') return global;
    if (typeof window !== 'undefined') return window;
    if (typeof self !== 'undefined') return self;
    return this || {};
  })();

  // Console polyfill
  if (typeof global.console === 'undefined') {
    global.console = {
      log: function() {
        var args = Array.prototype.slice.call(arguments);
        kernel_log(args.join(' '));
      },
      error: function() {
        var args = Array.prototype.slice.call(arguments);
        kernel_log('ERROR: ' + args.join(' '));
      },
      warn: function() {
        var args = Array.prototype.slice.call(arguments);
        kernel_log('WARN: ' + args.join(' '));
      },
      clear: function() {
        kernel_log('\\033[2J\\033[H'); // ANSI clear screen
      }
    };
  }
  
  // Date.now polyfill for ES5
  if (!Date.now) {
    Date.now = function() {
      return new Date().getTime();
    };
  }
  
  // Set polyfill for ES5 (minimal implementation)
  if (typeof Set === 'undefined') {
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
  
  // Map polyfill for ES5
  if (typeof Map === 'undefined') {
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
  
  // Promise polyfill (basic implementation for async/await)
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
      
      this.then = function(onFulfilled, onRejected) {
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
      
      this.catch = function(onRejected) {
        return this.then(null, onRejected);
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
  }
  
})();
`;

  let combinedCode = polyfills;
  
  // Process each file
  for (const file of jsFiles) {
    console.log(`   Adding ${file}...`);
    
    const inputPath = path.join(INPUT_DIR, file);
    let sourceCode = fs.readFileSync(inputPath, 'utf8');
    
    // Convert modern JS features to ES5-compatible code
    
    // Remove import/export statements
    sourceCode = sourceCode.replace(/^import\s+.*?from\s+.*?;?\s*$/gm, '');
    sourceCode = sourceCode.replace(/^export\s+(?:default\s+)?.*?;?\s*$/gm, '');
    sourceCode = sourceCode.replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, '');
    sourceCode = sourceCode.replace(/^export\s*\*\s+from\s+.*?;?\s*$/gm, '');
    
    // Convert private fields to regular properties
    sourceCode = sourceCode.replace(/#(\w+)/g, 'this._$1');
    
    // Convert const/let to var for better ES5 compatibility
    sourceCode = sourceCode.replace(/\b(const|let)\b/g, 'var');
    
    // Convert template literals to string concatenation - handle nested expressions carefully
    // First handle complex template literals with multiple expressions
    var templateLiteralRegex = /`([^`]*?)\$\{([^}]+?)\}([^`]*?)`/g;
    var maxIterations = 10; // Prevent infinite loops
    var iteration = 0;
    
    while (templateLiteralRegex.test(sourceCode) && iteration < maxIterations) {
      sourceCode = sourceCode.replace(templateLiteralRegex, function(match, before, expr, after) {
        // Escape any quotes in the literal parts
        before = before.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
        after = after.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
        return '"' + before + '" + (' + expr + ') + "' + after + '"';
      });
      templateLiteralRegex.lastIndex = 0;
      iteration++;
    }
    
    // Convert simple template literals (no expressions) 
    sourceCode = sourceCode.replace(/`([^`\$]*)`/g, function(match, content) {
      // Escape quotes, backslashes and newlines
      content = content.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
      return '"' + content + '"';
    });
    
    // Convert arrow functions to regular functions (basic cases)
    sourceCode = sourceCode.replace(/(\w+)\s*=>\s*{/g, 'function($1) {');
    sourceCode = sourceCode.replace(/(\w+)\s*=>\s*([^;,\n}]+)/g, 'function($1) { return $2; }');
    
    console.log(`   Converted modern features in ${file}`);
    
    combinedCode += `\n// === ${file} ===\n${sourceCode}\n`;
  }
  
  // Add main function call at the end
  combinedCode += `\n// Start the operating system\nif (typeof main === 'function') {\n  main().catch(function(error) {\n    console.error('Fatal error:', error);\n  });\n} else {\n  console.error('ERROR: main function not found');\n}\n`;

  // Write the final bundle
  fs.writeFileSync(BUNDLE_OUTPUT, combinedCode);
  
  console.log('✅ Successfully bundled TypeScript to ES5!');
  console.log(`   Output: ${BUNDLE_OUTPUT}`);
  console.log(`   Size:   ${Math.round(combinedCode.length / 1024 * 100) / 100}KB`);
}

// Run the bundler
try {
  bundleFiles();
} catch (error) {
  console.error('❌ Bundling failed:', error);
  process.exit(1);
}
