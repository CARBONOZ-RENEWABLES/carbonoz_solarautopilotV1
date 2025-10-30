// Memory optimization utilities
const fs = require('fs');
const path = require('path');

// Reduce message buffer sizes
const MAX_MESSAGES = 100; // Reduced from 500
const MAX_QUEUE_SIZE = 100; // Reduced from 500

// Memory cleanup intervals
const MEMORY_CLEANUP_INTERVAL = 30000; // 30 seconds
const SETTINGS_CLEANUP_INTERVAL = 300000; // 5 minutes

// Optimize message handling
function optimizeMessageBuffer(incomingMessages) {
  if (incomingMessages.length > MAX_MESSAGES) {
    const excess = incomingMessages.length - MAX_MESSAGES;
    incomingMessages.splice(0, excess);
  }
  return incomingMessages;
}

// Clean up old settings state
function cleanupSettingsState(currentSettingsState) {
  const now = Date.now();
  const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour instead of 24 hours
  
  Object.keys(currentSettingsState).forEach(category => {
    if (typeof currentSettingsState[category] === 'object' && category !== 'lastUpdated') {
      Object.keys(currentSettingsState[category]).forEach(inverterId => {
        if (currentSettingsState[category][inverterId] && 
            currentSettingsState[category][inverterId].lastUpdated) {
          const lastUpdated = new Date(currentSettingsState[category][inverterId].lastUpdated).getTime();
          if (now - lastUpdated > MAX_AGE_MS) {
            delete currentSettingsState[category][inverterId];
          }
        }
      });
    }
  });
}

// Force garbage collection if available
function forceGarbageCollection() {
  if (global.gc) {
    global.gc();
    console.log('🧹 Forced garbage collection');
  }
}

// Memory monitoring
function logMemoryUsage() {
  const used = process.memoryUsage();
  const mb = (bytes) => Math.round(bytes / 1024 / 1024 * 100) / 100;
  
  console.log(`📊 Memory Usage: RSS: ${mb(used.rss)}MB, Heap Used: ${mb(used.heapUsed)}MB, Heap Total: ${mb(used.heapTotal)}MB, External: ${mb(used.external)}MB`);
  
  // Alert if memory usage is high
  if (mb(used.heapUsed) > 400) {
    console.warn('⚠️  High memory usage detected!');
    forceGarbageCollection();
  }
}

module.exports = {
  MAX_MESSAGES,
  MAX_QUEUE_SIZE,
  MEMORY_CLEANUP_INTERVAL,
  SETTINGS_CLEANUP_INTERVAL,
  optimizeMessageBuffer,
  cleanupSettingsState,
  forceGarbageCollection,
  logMemoryUsage
};