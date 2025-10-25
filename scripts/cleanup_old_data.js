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

function cleanupDynamicPricing(filePath) {
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const today = new Date().toISOString().split('T')[0];
        
        if (data.pricingData) {
            data.pricingData = data.pricingData.filter(entry => 
                entry.timestamp >= today
            );
        }
        
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        return data.pricingData?.length || 0;
    } catch (e) {
        console.error('Error cleaning dynamic_pricing_config.json:', e.message);
        return 0;
    }
}

const dataPath = path.join(__dirname, '..', 'data');
const tibberFile = path.join(dataPath, 'tibber_cache.json');
const pricingFile = path.join(dataPath, 'dynamic_pricing_config.json');

console.log(`Starting cleanup at ${new Date()}`);

if (fs.existsSync(tibberFile)) {
    const tibberEntries = cleanupTibberCache(tibberFile);
    console.log(`Tibber cache: kept ${tibberEntries} current entries`);
}

if (fs.existsSync(pricingFile)) {
    const pricingEntries = cleanupDynamicPricing(pricingFile);
    console.log(`Pricing config: kept ${pricingEntries} current entries`);
}

console.log('Cleanup completed');