#!/bin/bash
set -e

echo "Embedding JavaScript into kernel..."

# Check if bundle file exists
if [ ! -f "build/bundle.js" ]; then
    echo "Error: build/bundle.js not found!"
    exit 1
fi

# Create embedded JS header
cat > src/kernel/embedded_js.h << 'EOF'
#ifndef EMBEDDED_JS_H
#define EMBEDDED_JS_H

// Auto-generated file - do not edit manually
// Contains the bundled JavaScript OS code

static const char* embedded_js_code = 
EOF

# Convert the bundled JS file to C string literal
echo "Embedding: build/bundle.js"
sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/\\n"/' "build/bundle.js" >> src/kernel/embedded_js.h

# Close the string
cat >> src/kernel/embedded_js.h << 'EOF'
;

#endif /* EMBEDDED_JS_H */
EOF

echo "JavaScript embedded successfully."
