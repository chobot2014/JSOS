/**
 * JSOS Main Entry Point
 * 
 * Modern JavaScript Operating System with namespace-based API
 * All functionality accessed via jsos.namespace.method pattern:
 * 
 *   jsos.system.info()      - System information
 *   jsos.process.list()     - Process management
 *   jsos.memory.stats()     - Memory statistics
 *   jsos.fs.ls()            - File system operations
 *   jsos.net.interfaces()   - Network management
 *   jsos.cli.exec('cmd')    - JavaScript CLI
 *   jsos.ui.window.create() - Web-based UI components
 *   jsos.event.on()         - Event system
 *   jsos.config.get()       - Configuration
 * 
 * Compiled to ES5 for Duktape runtime on baremetal
 */

// Import the unified JSOS namespace
import jsos, { main as jsosMain } from './jsos.js';

// Re-export for external access
export { jsos };

// Main entry point - delegates to jsos namespace
async function main(): Promise<void> {
  await jsosMain();
}

export default jsos;
export { main };

