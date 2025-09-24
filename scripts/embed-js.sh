#!/bin/bash

# Script to embed JavaScript code into C header file

BUNDLE_FILE="build/bundle.js"
OUTPUT_FILE="src/kernel/embedded_js.h"

if [ ! -f "$BUNDLE_FILE" ]; then
    echo "Error: $BUNDLE_FILE not found. Run 'npm run bundle' first."
    exit 1
fi

echo "Embedding JavaScript from $BUNDLE_FILE into $OUTPUT_FILE..."

# Create the header file with embedded JavaScript
cat > "$OUTPUT_FILE" << 'EOF'
#ifndef EMBEDDED_JS_H
#define EMBEDDED_JS_H

// Auto-generated embedded JavaScript code
static const char* embedded_js_code =
EOF

# Escape the JavaScript code and append it
# Handle Unicode escape sequences specially
sed 's/\\u001b/\\\\u001b/g; s/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/\\n"/' "$BUNDLE_FILE" >> "$OUTPUT_FILE"

# Close the string and header
cat >> "$OUTPUT_FILE" << 'EOF'
;

#endif /* EMBEDDED_JS_H */
EOF

echo "Embedded JavaScript code generated successfully."
