#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Simple bundler for CommonJS to single file for Duktape
function bundleCommonJS(inputDir, outputFile) {
    const modules = {};
    const polyfills = `
// Essential polyfills for Duktape
var global = this;
if (typeof console === 'undefined') {
    console = {
        log: function() {
            var args = Array.prototype.slice.call(arguments);
            print(args.join(' '));
        }
    };
}

// CommonJS module system
var require = (function() {
    var modules = {};
    var cache = {};
    
    function require(id) {
        if (cache[id]) return cache[id].exports;
        
        var module = cache[id] = { exports: {} };
        if (!modules[id]) throw new Error('Module not found: ' + id);
        
        modules[id](module, module.exports, require);
        return module.exports;
    }
    
    require.register = function(id, fn) {
        modules[id] = fn;
    };
    
    return require;
})();

`;

    let bundle = polyfills;
    
    // Read all .js files from the build directory
    function readModules(dir) {
        const files = fs.readdirSync(dir);
        
        for (const file of files) {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            
            if (stat.isDirectory()) {
                readModules(fullPath);
            } else if (file.endsWith('.js')) {
                const content = fs.readFileSync(fullPath, 'utf8');
                const moduleName = path.relative(inputDir, fullPath).replace(/\\/g, '/').replace(/\.js$/, '');
                
                // Wrap the module in CommonJS loader
                bundle += `require.register('${moduleName}', function(module, exports, require) {\n`;
                bundle += content;
                bundle += `\n});\n\n`;
            }
        }
    }
    
    readModules(inputDir);
    
    // Add the entry point
    bundle += `
// Start the OS
require('./main');
`;
    
    fs.writeFileSync(outputFile, bundle);
    console.log(`Bundle created: ${outputFile}`);
}

// Run the bundler
const inputDir = path.join(__dirname, '..', 'build', 'js');
const outputFile = path.join(__dirname, '..', 'build', 'bundle.js');

bundleCommonJS(inputDir, outputFile);
