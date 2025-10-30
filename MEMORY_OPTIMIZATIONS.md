# Memory Optimizations for CARBONOZ SolarAutopilot

## Problem
The Node.js application was consuming ~14GB of memory and being killed by the OOM (Out of Memory) killer in Home Assistant.

## Solutions Implemented

### 1. Memory Limits
- **Home Assistant Add-on**: Increased memory limit from 512MB to 1024MB in `config.yaml`
- **Node.js Heap**: Optimized heap size to 400MB (was 256MB) with better garbage collection
- **Docker**: Added memory-optimized Node.js flags

### 2. Buffer Size Reductions
- **Message Buffer**: Reduced from 500 to 100 messages
- **Queue Size**: Reduced from 500 to 100 items
- **Rate Limiting**: Reduced from 1000 to 200 entries
- **JSON Payload**: Reduced from 10MB to 1MB limit
- **Message Size**: Reduced from 10KB to 1KB per message

### 3. Memory Cleanup
- **Automatic Cleanup**: Added cron job every 5 minutes to clean old data
- **Data Retention**: Reduced from 24 hours to 1 hour for settings state
- **Garbage Collection**: Enabled manual GC and automatic triggering
- **Buffer Management**: More aggressive message buffer pruning

### 4. Optimized Startup
- **New Script**: `start-optimized.js` with memory monitoring
- **Environment Variables**: Optimized Node.js flags for memory efficiency
- **Monitoring**: Real-time memory usage logging every 30 seconds

### 5. Configuration Changes

#### config.yaml
```yaml
memory_limit: 1024mb  # Increased from 512mb
```

#### Dockerfile
```dockerfile
ENV NODE_OPTIONS="--expose-gc --max-old-space-size=400 --max-semi-space-size=32 --optimize-for-size"
ENV UV_THREADPOOL_SIZE=4
```

#### package.json
```json
"scripts": {
  "start": "node start-optimized.js",
  "start-basic": "node server.js"
}
```

### 6. Memory Monitoring
- **Script**: `scripts/memory-monitor.sh` for system monitoring
- **Automatic**: Built-in memory usage logging
- **Alerts**: Warnings when memory usage exceeds thresholds
- **Cleanup**: Automatic optimization when memory is high

### 7. Code Optimizations
- Reduced MQTT message processing overhead
- Smaller batch sizes for database operations
- More efficient string handling
- Optimized JSON parsing limits
- Aggressive cleanup of old data structures

## Expected Results
- **Memory Usage**: Should stay under 800MB total
- **Stability**: No more OOM kills
- **Performance**: Better garbage collection
- **Monitoring**: Real-time memory tracking

## Usage
1. **Normal Start**: `npm start` (uses optimized script)
2. **Basic Start**: `npm run start-basic` (fallback)
3. **Monitor Memory**: `./scripts/memory-monitor.sh`

## Monitoring Commands
```bash
# Check memory usage
free -h

# Monitor Node.js process
ps aux | grep node

# Check for OOM kills
dmesg | grep -i "killed process"

# Run memory monitor
./scripts/memory-monitor.sh
```

## Emergency Actions
If memory issues persist:
1. Restart the add-on
2. Check logs for memory warnings
3. Run memory monitor script
4. Consider reducing inverter/battery numbers in config
5. Use basic startup script as fallback

## Files Modified
- `config.yaml` - Increased memory limit
- `Dockerfile` - Optimized Node.js environment
- `server.js` - Reduced buffer sizes and added cleanup
- `package.json` - Updated startup script
- `rootfs/usr/bin/carbonoz.sh` - Optimized Node.js flags
- `start-optimized.js` - New memory-optimized startup
- `scripts/memory-monitor.sh` - Memory monitoring tool
- `MEMORY_OPTIMIZATIONS.md` - This documentation