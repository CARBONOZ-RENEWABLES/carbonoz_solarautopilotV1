// Memory Monitor Utility for CARBONOZ SolarAutopilot
// Helps track memory usage and identify potential leaks

class MemoryMonitor {
  constructor() {
    this.baseline = null;
    this.samples = [];
    this.maxSamples = 100;
    this.alertThreshold = 0.8; // Alert when memory usage exceeds 80% of limit
  }

  start() {
    console.log('🔍 Starting memory monitor...');
    this.baseline = process.memoryUsage();
    
    // Monitor every 30 seconds
    this.interval = setInterval(() => {
      this.checkMemory();
    }, 30000);
    
    // Detailed report every 5 minutes
    this.reportInterval = setInterval(() => {
      this.generateReport();
    }, 300000);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
    }
    if (this.reportInterval) {
      clearInterval(this.reportInterval);
    }
    console.log('🔍 Memory monitor stopped');
  }

  checkMemory() {
    const usage = process.memoryUsage();
    const sample = {
      timestamp: new Date(),
      rss: usage.rss,
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external,
      arrayBuffers: usage.arrayBuffers || 0
    };

    this.samples.push(sample);
    
    // Keep only recent samples
    if (this.samples.length > this.maxSamples) {
      this.samples = this.samples.slice(-this.maxSamples);
    }

    // Check for memory alerts
    this.checkAlerts(sample);
  }

  checkAlerts(sample) {
    const heapUsedMB = sample.heapUsed / 1024 / 1024;
    const rssMB = sample.rss / 1024 / 1024;
    
    // Get memory limit from environment or default to 512MB
    const memoryLimit = parseInt(process.env.NODE_OPTIONS?.match(/--max-old-space-size=(\d+)/)?.[1] || '512');
    
    if (heapUsedMB > memoryLimit * this.alertThreshold) {
      console.warn(`⚠️  HIGH MEMORY USAGE: Heap ${heapUsedMB.toFixed(1)}MB / ${memoryLimit}MB (${((heapUsedMB/memoryLimit)*100).toFixed(1)}%)`);
      
      // Suggest garbage collection
      if (global.gc && heapUsedMB > memoryLimit * 0.9) {
        console.log('🗑️  Triggering garbage collection...');
        global.gc();
        
        // Check memory after GC
        setTimeout(() => {
          const afterGC = process.memoryUsage();
          const newHeapMB = afterGC.heapUsed / 1024 / 1024;
          const freed = heapUsedMB - newHeapMB;
          console.log(`♻️  GC freed ${freed.toFixed(1)}MB (now ${newHeapMB.toFixed(1)}MB)`);
        }, 1000);
      }
    }
  }

  generateReport() {
    if (this.samples.length < 2) return;

    const latest = this.samples[this.samples.length - 1];
    const oldest = this.samples[0];
    
    const heapGrowth = (latest.heapUsed - oldest.heapUsed) / 1024 / 1024;
    const rssGrowth = (latest.rss - oldest.rss) / 1024 / 1024;
    
    console.log('📊 Memory Report:');
    console.log(`   Current: Heap ${(latest.heapUsed/1024/1024).toFixed(1)}MB, RSS ${(latest.rss/1024/1024).toFixed(1)}MB`);
    console.log(`   Growth: Heap ${heapGrowth > 0 ? '+' : ''}${heapGrowth.toFixed(1)}MB, RSS ${rssGrowth > 0 ? '+' : ''}${rssGrowth.toFixed(1)}MB`);
    
    // Calculate average memory usage
    const avgHeap = this.samples.reduce((sum, s) => sum + s.heapUsed, 0) / this.samples.length / 1024 / 1024;
    const avgRSS = this.samples.reduce((sum, s) => sum + s.rss, 0) / this.samples.length / 1024 / 1024;
    console.log(`   Average: Heap ${avgHeap.toFixed(1)}MB, RSS ${avgRSS.toFixed(1)}MB`);
    
    // Detect potential memory leaks
    if (heapGrowth > 50) { // More than 50MB growth
      console.warn(`🚨 POTENTIAL MEMORY LEAK: Heap grew by ${heapGrowth.toFixed(1)}MB`);
      this.suggestOptimizations();
    }
  }

  suggestOptimizations() {
    console.log('💡 Memory Optimization Suggestions:');
    console.log('   • Check for unclosed database connections');
    console.log('   • Review MQTT message buffer sizes');
    console.log('   • Clear old cache entries');
    console.log('   • Limit AI model training data');
    console.log('   • Check for event listener leaks');
  }

  getStats() {
    if (this.samples.length === 0) return null;

    const latest = this.samples[this.samples.length - 1];
    return {
      current: {
        heapUsedMB: latest.heapUsed / 1024 / 1024,
        rssMB: latest.rss / 1024 / 1024,
        heapTotalMB: latest.heapTotal / 1024 / 1024
      },
      samples: this.samples.length,
      timespan: this.samples.length > 1 ? 
        (latest.timestamp - this.samples[0].timestamp) / 1000 / 60 : 0 // minutes
    };
  }
}

// Export singleton instance
const memoryMonitor = new MemoryMonitor();

// Auto-start in production
if (process.env.NODE_ENV === 'production') {
  memoryMonitor.start();
  
  // Graceful shutdown
  process.on('SIGTERM', () => memoryMonitor.stop());
  process.on('SIGINT', () => memoryMonitor.stop());
}

module.exports = memoryMonitor;