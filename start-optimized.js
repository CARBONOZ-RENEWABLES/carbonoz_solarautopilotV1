#!/usr/bin/env node

// Memory-optimized startup script for CARBONOZ SolarAutopilot
// This script sets Node.js memory limits and garbage collection options

const { spawn } = require('child_process');
const path = require('path');

console.log('🚀 Starting CARBONOZ SolarAutopilot with memory optimizations...');

// Calculate optimal memory limits based on available system memory
const totalMemoryMB = require('os').totalmem() / 1024 / 1024;
const maxHeapMB = Math.min(512, Math.floor(totalMemoryMB * 0.3)); // Use max 512MB or 30% of system memory

console.log(`💾 System Memory: ${Math.round(totalMemoryMB)}MB`);
console.log(`🎯 Node.js Heap Limit: ${maxHeapMB}MB`);

// Node.js optimization flags
const nodeFlags = [
  `--max-old-space-size=${maxHeapMB}`,     // Limit heap size
  '--max-semi-space-size=64',               // Limit young generation
  '--optimize-for-size',                    // Optimize for memory usage
  '--gc-interval=100',                      // More frequent GC
  '--expose-gc',                            // Allow manual GC
  '--trace-warnings',                       // Show memory warnings
];

// Start the application with optimized settings
const child = spawn('node', [...nodeFlags, 'server.js'], {
  stdio: 'inherit',
  cwd: __dirname,
  env: {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || 'production',
    UV_THREADPOOL_SIZE: '4', // Limit thread pool
  }
});

// Handle process signals
process.on('SIGTERM', () => {
  console.log('📴 Received SIGTERM, shutting down gracefully...');
  child.kill('SIGTERM');
});

process.on('SIGINT', () => {
  console.log('📴 Received SIGINT, shutting down gracefully...');
  child.kill('SIGINT');
});

// Monitor memory usage
let memoryCheckInterval;
if (process.env.NODE_ENV !== 'production') {
  memoryCheckInterval = setInterval(() => {
    const memUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const rssMB = Math.round(memUsage.rss / 1024 / 1024);
    
    if (heapUsedMB > maxHeapMB * 0.8) {
      console.warn(`⚠️  High memory usage: Heap ${heapUsedMB}MB, RSS ${rssMB}MB`);
    }
  }, 30000); // Check every 30 seconds
}

child.on('exit', (code, signal) => {
  if (memoryCheckInterval) {
    clearInterval(memoryCheckInterval);
  }
  
  if (signal) {
    console.log(`📴 Process terminated by signal: ${signal}`);
  } else {
    console.log(`📴 Process exited with code: ${code}`);
  }
  
  process.exit(code || 0);
});

child.on('error', (error) => {
  console.error('❌ Failed to start process:', error);
  process.exit(1);
});

console.log('✅ Memory-optimized CARBONOZ SolarAutopilot started');