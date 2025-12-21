#!/usr/bin/env node

// Simple memory monitor for debugging OOM issues
setInterval(() => {
  const mem = process.memoryUsage();
  const used = Math.round(mem.heapUsed / 1024 / 1024);
  const total = Math.round(mem.heapTotal / 1024 / 1024);
  const rss = Math.round(mem.rss / 1024 / 1024);
  
  console.log(`Memory: Heap ${used}/${total}MB, RSS ${rss}MB`);
  
  if (used > 100) {
    console.warn('⚠️ High memory usage detected');
    if (global.gc) global.gc();
  }
}, 5000);