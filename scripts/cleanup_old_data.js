#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function cleanupTibberCache(filePath) {
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const today = new Date().toISOString().split('T')[0];
        
        if (data.priceInfo?.today) {
            data.priceInfo.today = data.priceInfo.today.filter(entry => 
                entry.startsAt.startsWith(today)
            );
        }
        
        if (data.forecast) {
            data.forecast = data.forecast.filter(entry => 
                entry.startsAt >= today
            );
        }
        
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        return data.priceInfo?.today?.length || 0;
    } catch (e) {
        console.error('Error cleaning tibber_cache.json:', e.message);
        return 0;
    }
}

// Dynamic pricing cleanup removed - using InfluxDB for pricing data storage

const dataPath = path.join(__dirname, '..', 'data');
const tibberFile = path.join(dataPath, 'tibber_cache.json');
// Pricing file cleanup removed - using InfluxDB

console.log(`Starting cleanup at ${new Date()}`);

if (fs.existsSync(tibberFile)) {
    const tibberEntries = cleanupTibberCache(tibberFile);
    console.log(`Tibber cache: kept ${tibberEntries} current entries`);
}

// Dynamic pricing cleanup skipped - using InfluxDB for pricing data

console.log('Cleanup completed');