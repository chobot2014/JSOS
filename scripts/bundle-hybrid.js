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

/** Recursively collect all .ts files under a directory, returning relative paths */
function findTsFiles(dir, base) {
  base = base || dir;
  var results = [];
  fs.readdirSync(dir).forEach(function(entry) {
    var full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) {
      findTsFiles(full, base).forEach(function(f) { results.push(f); });
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      results.push(path.relative(base, full));
    }
  });
  return results;
}

async function bundleForQuickJS() {
  console.log('🔨 Bundling TypeScript for QuickJS (ES2023)...');
  
  // Ensure directories exist
  if (!fs.existsSync(BUILD_DIR)) {
    fs.mkdirSync(BUILD_DIR, { recursive: true });
  }
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  // Find TypeScript files recursively
  const tsFiles = findTsFiles(SRC_DIR);
  
  if (tsFiles.length === 0) {
    console.error('❌ No TypeScript files found in src/os directory');
    process.exit(1);
  }

  console.log(`   Found ${tsFiles.length} TypeScript files`);

  try {
    // Step 1: Strip TypeScript types with Babel (minimal transform)
    for (const tsFile of tsFiles) {
      console.log(`   Transforming ${tsFile}...`);
      
      const inputPath = path.join(SRC_DIR, tsFile);
      const outputPath = path.join(TEMP_DIR, tsFile.replace('.ts', '.js'));
      
      // Ensure the subdirectory exists in temp
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      
      const sourceCode = fs.readFileSync(inputPath, 'utf8');
      
      const result = await babel.transformAsync(sourceCode, {
        filename: tsFile,
        presets: [
          '@babel/preset-typescript'
        ],
        plugins: [
          // Only transform TypeScript-specific features
          '@babel/plugin-transform-class-properties',
          '@babel/plugin-transform-private-methods',
          '@babel/plugin-transform-private-property-in-object',
        ]
      });

      if (!result || !result.code) {
        throw new Error(`Failed to transform ${tsFile}`);
      }

      fs.writeFileSync(outputPath, result.code);
    }

    console.log('✅ TypeScript → JavaScript transformation complete');

    // Step 2: Bundle with esbuild
    console.log('   Bundling with esbuild...');

    const mainFile = path.join(TEMP_DIR, 'core', 'main.js');
    if (!fs.existsSync(mainFile)) {
      console.error('❌ core/main.js not found after transformation');
      process.exit(1);
    }

    const result = await esbuild.build({
      entryPoints: [mainFile],
      bundle: true,
      outfile: OUTPUT_FILE,
      format: 'iife',
      target: 'es2020',   // QuickJS supports ES2023 natively!
      platform: 'neutral',
      minify: false,
      sourcemap: false,
    });

    if (result.errors.length > 0) {
      console.error('❌ esbuild errors:');
      result.errors.forEach(error => console.error(error));
      process.exit(1);
    }

    // Step 3: Inject main() call inside the IIFE
    let bundledCode = fs.readFileSync(OUTPUT_FILE, 'utf8');
    
    const mainCall = [
      '',
      '  // Start the operating system',
      '  try {',
      '    main();',
      '  } catch (error) {',
      '    kernel.print("FATAL startup error: " + error);',
      '    kernel.halt();',
      '  }'
    ].join('\n');
    
    const lastIIFE = bundledCode.lastIndexOf('})();');
    if (lastIIFE !== -1) {
      bundledCode = bundledCode.slice(0, lastIIFE) + mainCall + '\n' + bundledCode.slice(lastIIFE);
    } else {
      bundledCode += '\ntry { main(); } catch(e) { kernel.print("FATAL: " + e); kernel.halt(); }\n';
    }
    
    fs.writeFileSync(OUTPUT_FILE, bundledCode);

    // Clean up temp files
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });

    const stats = fs.statSync(OUTPUT_FILE);
    console.log('✅ Successfully bundled for QuickJS!');
    console.log(`   Output: ${OUTPUT_FILE}`);
    console.log(`   Size:   ${Math.round(stats.size / 1024 * 100) / 100}KB`);
    console.log('   Target: ES2023 (native QuickJS — no polyfills needed!)');

  } catch (error) {
    console.error('❌ Bundling failed:', error);
    process.exit(1);
  }
}

// Run the bundler
bundleForQuickJS().catch(error => {
  console.error('❌ Bundling failed:', error);
  process.exit(1);
});
