#!/bin/bash

# Memory monitoring script for CARBONOZ SolarAutopilot

echo "🔍 CARBONOZ SolarAutopilot Memory Monitor"
echo "========================================="

# Function to check memory usage
check_memory() {
    echo "📊 Current Memory Usage:"
    free -h
    echo ""
    
    echo "🔍 Process Memory Usage:"
    ps aux | grep -E "(node|carbonoz)" | grep -v grep
    echo ""
    
    echo "📈 System Load:"
    uptime
    echo ""
}

# Function to check for OOM kills
check_oom() {
    echo "⚠️  Checking for recent OOM kills:"
    dmesg | grep -i "killed process" | tail -5
    echo ""
}

# Function to optimize memory
optimize_memory() {
    echo "🧹 Running memory optimization..."
    
    # Clear page cache
    sync
    echo 1 > /proc/sys/vm/drop_caches
    
    # Force garbage collection if Node.js process is running
    pkill -USR2 node 2>/dev/null || true
    
    echo "✅ Memory optimization completed"
    echo ""
}

# Main monitoring loop
while true; do
    clear
    echo "🔍 CARBONOZ SolarAutopilot Memory Monitor - $(date)"
    echo "========================================="
    
    check_memory
    check_oom
    
    # Check if memory usage is high
    MEMORY_USAGE=$(free | grep Mem | awk '{printf "%.0f", $3/$2 * 100.0}')
    
    if [ "$MEMORY_USAGE" -gt 80 ]; then
        echo "⚠️  High memory usage detected: ${MEMORY_USAGE}%"
        optimize_memory
    fi
    
    echo "Press Ctrl+C to exit. Next check in 30 seconds..."
    sleep 30
done