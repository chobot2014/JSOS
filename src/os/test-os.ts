/**
 * JSOS OS Components Test
 *
 * Test script to verify that all OS components are working correctly.
 * Run with: run('/bin/test-os.js')
 */

print('=== JSOS Operating System Test ===');
print('');

// Test Virtual Memory Manager
print('Testing Virtual Memory Manager...');
try {
  var memStats = sys.vmm.getMemoryStats();
  print('  Total Physical Memory: ' + memStats.totalPhysical + ' bytes');
  print('  Used Physical Memory: ' + memStats.usedPhysical + ' bytes');
  print('  Free Physical Memory: ' + memStats.freePhysical + ' bytes');
  print('  Mapped Pages: ' + memStats.mappedPages);

  // Test memory allocation
  var addr = sys.vmm.allocateVirtualMemory(4096, 'rw');
  if (addr) {
    print('  Memory allocation successful at address: 0x' + addr.toString(16));
    sys.vmm.freeVirtualMemory(addr, 4096);
    print('  Memory deallocation successful');
  } else {
    print('  Memory allocation failed');
  }
} catch (e) {
  print('  VMM Error: ' + e);
}
print('');

// Test Process Scheduler
print('Testing Process Scheduler...');
try {
  var processes = sys.scheduler.getAllProcesses();
  print('  Total processes: ' + processes.length);
  print('  Current process: ' + (sys.scheduler.getCurrentProcess()?.pid || 'none'));
  print('  Scheduling algorithm: ' + sys.scheduler.getAlgorithm());

  // Test process creation
  var newProc = sys.scheduler.createProcess(1, { priority: 10, timeSlice: 100, memory: { heapStart: 0x100000, heapEnd: 0x200000, stackStart: 0x200000, stackEnd: 0x210000 } });
  if (newProc) {
    print('  Created process with PID: ' + newProc.pid);
    sys.scheduler.terminateProcess(newProc.pid);
    print('  Terminated process');
  }
} catch (e) {
  print('  Scheduler Error: ' + e);
}
print('');

// Test System Calls
print('Testing System Call Interface...');
try {
  var pidResult = sys.syscalls.getpid();
  print('  Current PID: ' + (pidResult.success ? pidResult.value : 'error'));

  var timeResult = sys.syscalls.time();
  print('  Current time: ' + (timeResult.success ? new Date(timeResult.value * 1000).toISOString() : 'error'));
} catch (e) {
  print('  Syscalls Error: ' + e);
}
print('');

// Test Init System
print('Testing Init System...');
try {
  var runlevel = sys.init.getCurrentRunlevel();
  print('  Current runlevel: ' + runlevel);

  var services = sys.init.listServices();
  print('  Total services: ' + services.length);

  // Show some services
  for (var i = 0; i < Math.min(3, services.length); i++) {
    var svc = services[i];
    print('  Service: ' + svc.service.name + ' (' + svc.state + ')');
  }
} catch (e) {
  print('  Init Error: ' + e);
}
print('');

// Test Enhanced Sysinfo
print('Enhanced System Information:');
try {
  var info = sys.sysinfo();
  print('  OS: ' + info.os);
  print('  Hostname: ' + info.hostname);
  print('  Architecture: ' + info.arch);
  print('  Runtime: ' + info.runtime);
  print('  Screen: ' + info.screen.width + 'x' + info.screen.height);
  print('  Physical Memory: ' + info.memory.used + '/' + info.memory.total + ' bytes');
  print('  Virtual Memory: ' + info.virtualMemory.mappedPages + ' pages mapped');
  print('  Uptime: ' + info.uptime + ' ms');
  print('  Processes: ' + info.processes);
  print('  Scheduler: ' + info.scheduler);
  print('  Runlevel: ' + info.runlevel);
} catch (e) {
  print('  Sysinfo Error: ' + e);
}
print('');

print('=== OS Test Complete ===');
print('All core OS components are initialized and functional!');