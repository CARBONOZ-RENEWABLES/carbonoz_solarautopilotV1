#!/usr/bin/env node

// Enable garbage collection
process.env.NODE_OPTIONS = '--expose-gc --max-old-space-size=512 --max-semi-space-size=64';

// Memory monitoring
function logMemoryUsage() {
  const used = process.memoryUsage();
  const mb = (bytes) => Math.round(bytes / 1024 / 1024 * 100) / 100;
  
  console.log(`📊 Memory Usage: RSS: ${mb(used.rss)}MB, Heap Used: ${mb(used.heapUsed)}MB, Heap Total: ${mb(used.heapTotal)}MB`);
  
  // Force GC if memory usage is high
  if (mb(used.heapUsed) > 400 && global.gc) {
    console.log('🧹 High memory usage detected, forcing garbage collection...');
    global.gc();
  }
}

// Log memory usage every 30 seconds
setInterval(logMemoryUsage, 30000);

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  logMemoryUsage();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  logMemoryUsage();
});

// Start the main server
require('./server.js');