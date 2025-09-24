#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');
const { minify } = require('terser');

// Configuration
const INPUT_DIR = path.join(__dirname, '..', 'build', 'js');
const OUTPUT_DIR = path.join(__dirname, '..', 'build');
const BUNDLE_OUTPUT = path.join(OUTPUT_DIR, 'bundle.js');

// Babel configuration for ES5 transpilation
const babelConfig = {
  presets: [
    [
      '@babel/preset-env',
      {
        targets: {
          browsers: ['ie 11'] // Forces ES5 output
        },
        modules: false,
        useBuiltIns: false,
        corejs: false
      }
    ]
  ],
  plugins: [
    '@babel/plugin-transform-class-properties',
    '@babel/plugin-transform-nullish-coalescing-operator',
    '@babel/plugin-transform-optional-chaining',
    '@babel/plugin-transform-private-methods',
    '@babel/plugin-transform-private-property-in-object'
  ]
};

// Terser configuration for minification
const terserConfig = {
  ecma: 5,
  compress: {
    dead_code: true,
    drop_console: false,
    drop_debugger: true,
    keep_fargs: false,
    keep_fnames: false,
    keep_infinity: false
  },
  mangle: {
    keep_fnames: false
  },
  format: {
    comments: false,
    beautify: false
  }
};

async function bundleFiles() {
  console.log('🔨 Bundling TypeScript to ES5 for Duktape...');
  
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

  let combinedCode = '';
  
  // Process each file
  for (const file of jsFiles) {
    console.log(`   Processing ${file}...`);
    
    const inputPath = path.join(INPUT_DIR, file);
    const sourceCode = fs.readFileSync(inputPath, 'utf8');
    
    try {
      // Transform with Babel to ES5
      const result = await babel.transformAsync(sourceCode, {
        ...babelConfig,
        filename: file
      });
      
      if (!result || !result.code) {
        throw new Error(`Babel transformation failed for ${file}`);
      }
      
      combinedCode += `\n// === ${file} ===\n${result.code}\n`;
      
    } catch (error) {
      console.error(`❌ Error processing ${file}:`, error.message);
      process.exit(1);
    }
  }

  // Add module system polyfill for Duktape
  const moduleSystemPolyfill = `
// Module system polyfill for Duktape
(function() {
  'use strict';
  
  var global = this;
  var modules = {};
  var exports = {};
  
  // Simple require implementation
  global.require = function(name) {
    return modules[name] || {};
  };
  
  global.exports = exports;
  global.module = { exports: exports };
  
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
      }
    };
  }
})();
`;

  const finalCode = moduleSystemPolyfill + combinedCode;

  try {
    // Minify the combined code
    console.log('   Minifying code...');
    const minified = await minify(finalCode, terserConfig);
    
    if (!minified.code) {
      throw new Error('Minification failed');
    }

    // Write the final bundled JavaScript
    console.log('   Writing bundle.js...');
    fs.writeFileSync(BUNDLE_OUTPUT, minified.code);
    
    console.log('✅ Successfully bundled TypeScript to ES5!');
    console.log(`   Output: ${BUNDLE_OUTPUT}`);
    console.log(`   Size:   ${Math.round(minified.code.length / 1024 * 100) / 100}KB minified`);
    console.log('   Next: run embed-js.sh to embed into C header');
    
  } catch (error) {
    console.error('❌ Error during minification:', error.message);
    process.exit(1);
  }
}

// Run the bundler
bundleFiles().catch(error => {
  console.error('❌ Bundling failed:', error);
  process.exit(1);
});
