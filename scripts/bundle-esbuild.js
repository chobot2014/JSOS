#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

// Configuration
const SRC_DIR = path.join(__dirname, '..', 'src', 'os');
const BUILD_DIR = path.join(__dirname, '..', 'build');
const OUTPUT_FILE = path.join(BUILD_DIR, 'bundle.js');

async function bundleWithEsbuild() {
  console.log('🔨 Bundling TypeScript with esbuild for Duktape...');
  
  // Ensure build directory exists
  if (!fs.existsSync(BUILD_DIR)) {
    fs.mkdirSync(BUILD_DIR, { recursive: true });
  }

  // Find the main entry point
  const mainFile = path.join(SRC_DIR, 'main.ts');
  if (!fs.existsSync(mainFile)) {
    console.error('❌ main.ts not found in src/os directory');
    process.exit(1);
  }

  try {
    // Create Duktape compatibility polyfills
    const duktapePolyfills = `
// Duktape compatibility layer and ES5 polyfills
(function() {
  'use strict';
  
  var global = (function() {
    if (typeof global !== 'undefined') return global;
    if (typeof window !== 'undefined') return window;
    if (typeof self !== 'undefined') return self;
    return this || {};
  })();

  // Console polyfill for kernel integration
  if (typeof global.console === 'undefined') {
    global.console = {
      log: function() {
        var args = Array.prototype.slice.call(arguments);
        if (typeof kernel_log !== 'undefined') {
          kernel_log(args.join(' '));
        } else {
          // Fallback for testing
          print(args.join(' '));
        }
      },
      error: function() {
        var args = Array.prototype.slice.call(arguments);
        if (typeof kernel_log !== 'undefined') {
          kernel_log('ERROR: ' + args.join(' '));
        } else {
          print('ERROR: ' + args.join(' '));
        }
      },
      warn: function() {
        var args = Array.prototype.slice.call(arguments);
        if (typeof kernel_log !== 'undefined') {
          kernel_log('WARN: ' + args.join(' '));
        } else {
          print('WARN: ' + args.join(' '));
        }
      },
      clear: function() {
        if (typeof kernel_log !== 'undefined') {
          kernel_log('\\033[2J\\033[H'); // ANSI clear screen
        }
      }
    };
  }
  
  // Essential polyfills for Duktape
  if (!Date.now) {
    Date.now = function() { return new Date().getTime(); };
  }
  
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
  
})();

`;

    const result = await esbuild.build({
      entryPoints: [mainFile],
      bundle: true,
      outfile: OUTPUT_FILE + '.temp',
      format: 'iife', // Immediately Invoked Function Expression - no modules
      target: 'es5',
      platform: 'neutral', // Don't assume Node.js or browser
      globalName: 'JSOS', // Wrap everything in JSOS namespace
      minify: false, // Keep readable for debugging
      sourcemap: false,
      define: {
        // Define any globals that might be needed
        'process.env.NODE_ENV': '"production"'
      },
      banner: {
        js: duktapePolyfills
      },
      footer: {
        js: `
// Start the operating system
(function() {
  try {
    if (typeof JSOS !== 'undefined' && typeof JSOS.main === 'function') {
      console.log('Starting JSOS...');
      var result = JSOS.main();
      if (result && typeof result.catch === 'function') {
        result.catch(function(error) {
          console.error('Fatal error:', error);
        });
      }
    } else if (typeof main === 'function') {
      console.log('Starting with global main...');
      var result = main();
      if (result && typeof result.catch === 'function') {
        result.catch(function(error) {
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
      console.error('❌ Build errors:');
      result.errors.forEach(error => console.error(error));
      process.exit(1);
    }

    if (result.warnings.length > 0) {
      console.warn('⚠️ Build warnings:');
      result.warnings.forEach(warning => console.warn(warning));
    }

    // Read the temporary output and post-process for Duktape compatibility
    let bundledCode = fs.readFileSync(OUTPUT_FILE + '.temp', 'utf8');
    
    // Additional post-processing for Duktape compatibility
    // Convert any remaining let/const to var (esbuild should handle this, but just in case)
    bundledCode = bundledCode.replace(/\b(const|let)\b/g, 'var');
    
    // Write the final bundle
    fs.writeFileSync(OUTPUT_FILE, bundledCode);
    
    // Clean up temp file
    fs.unlinkSync(OUTPUT_FILE + '.temp');

    console.log('✅ Successfully bundled with esbuild!');
    console.log(`   Output: ${OUTPUT_FILE}`);
    console.log(`   Size:   ${Math.round(bundledCode.length / 1024 * 100) / 100}KB`);

  } catch (error) {
    console.error('❌ esbuild failed:', error);
    process.exit(1);
  }
}

// Run the bundler
bundleWithEsbuild().catch(error => {
  console.error('❌ Bundling failed:', error);
  process.exit(1);
});
