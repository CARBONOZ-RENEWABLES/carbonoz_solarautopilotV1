// pricingApis.js

/**
 * Pricing API integrations for the dynamic pricing feature
 * This module provides integrations with various electricity pricing APIs
 */

const axios = require('axios');
const moment = require('moment-timezone');

/**
 * Fetch electricity prices from ENTSO-E API
 * @param {Object} config - Configuration with apiKey and market settings
 * @returns {Array} Price data points
 */
async function fetchEntsoeElectricityPrices(config) {
  if (!config.apiKey) {
    console.error('API key for ENTSO-E is missing');
    return [];
  }
  
  try {
    const today = moment().format('YYYYMMDD');
    const tomorrow = moment().add(1, 'day').format('YYYYMMDD');
    
    // ENTSO-E API uses specific area codes
    const areaCodeMap = {
      'DE': '10Y1001A1001A83F', // Germany
      'FR': '10Y1001A1001A39I', // France
      'ES': '10YES-REE------0', // Spain
      'IT': '10Y1001A1001A73I', // Italy
      'UK': '10Y1001A1001A92E', // UK
      'NL': '10Y1001A1001A16H', // Netherlands
      'BE': '10YBE----------2', // Belgium
      'AT': '10YAT-APG------L', // Austria
      'CH': '10YCH-SWISSGRIDZ', // Switzerland
      'DK': '10Y1001A1001A65H', // Denmark
      'NO': '10YNO-0--------C', // Norway
      'SE': '10YSE-1--------K', // Sweden
      'FI': '10YFI-1--------U', // Finland
      'PL': '10YPL-AREA-----S', // Poland
      'CZ': '10YCZ-CEPS-----N', // Czech Republic
      'SK': '10YSK-SEPS-----K', // Slovakia
      'HU': '10YHU-MAVIR----U', // Hungary
      'RO': '10YRO-TEL------P', // Romania
      'BG': '10YCA-BULGARIA-R', // Bulgaria
      'GR': '10YGR-HTSO-----Y', // Greece
      'PT': '10YPT-REN------W'  // Portugal
    };
    
    const areaCode = areaCodeMap[config.market] || areaCodeMap['DE'];
    
    const url = `https://transparency.entsoe.eu/api?documentType=A44&in_Domain=${areaCode}&out_Domain=${areaCode}&periodStart=${today}0000&periodEnd=${tomorrow}2300&securityToken=${config.apiKey}`;
    
    const response = await axios.get(url, { 
      headers: { 'Content-Type': 'application/xml' },
      timeout: 15000
    });
    
    // Parse XML response
    const rawData = response.data;
    return parseEntsoeXmlResponse(rawData);
  } catch (error) {
    console.error('Error fetching ENTSO-E electricity prices:', error.message);
    return [];
  }
}

/**
 * Parse ENTSO-E XML response
 * @param {String} xmlData - XML data from ENTSO-E API
 * @returns {Array} Parsed price data points
 */
function parseEntsoeXmlResponse(xmlData) {
  try {
    const prices = [];
    // ENTSO-E provides hourly prices in EUR/MWh
    
    // For a full implementation, you would use an XML parser like xml2js
    // This is a simplified version with regex pattern matching since we don't want to add more dependencies
    
    // Extract the time period and price points
    const timePeriodPattern = /<time_Period>\s*<timeInterval>\s*<start>(.*?)<\/start>\s*<end>(.*?)<\/end>\s*<\/timeInterval>\s*<\/time_Period>/s;
    const timePeriodMatch = xmlData.match(timePeriodPattern);
    
    if (!timePeriodMatch) {
      console.error('Failed to extract time period from ENTSO-E response');
      return [];
    }
    
    const startTime = moment(timePeriodMatch[1]);
    
    // Extract price points
    const pointPattern = /<Point>\s*<position>(.*?)<\/position>\s*<price\.amount>(.*?)<\/price\.amount>\s*<\/Point>/g;
    let pointMatch;
    
    while ((pointMatch = pointPattern.exec(xmlData)) !== null) {
      const position = parseInt(pointMatch[1]);
      const priceAmount = parseFloat(pointMatch[2]);
      
      // Convert from EUR/MWh to EUR/kWh
      const pricePerKwh = priceAmount / 1000;
      
      // Calculate timestamp (position 1 = first hour of the interval)
      const timestamp = moment(startTime).add(position - 1, 'hours');
      
      prices.push({
        timestamp: timestamp.toISOString(),
        price: pricePerKwh,
        currency: 'EUR',
        unit: 'kWh'
      });
    }
    
    // If parsing failed, return empty array
    if (prices.length === 0) {
      console.error('Failed to extract price points from ENTSO-E response');
      return [];
    }
    
    return prices;
  } catch (error) {
    console.error('Error parsing ENTSO-E XML response:', error.message);
    
    // Fallback to sample data for testing
    return generateSamplePriceData();
  }
}

/**
 * Fetch prices from AWATTAR API (Germany and Austria)
 * @param {Object} config - Configuration with country settings
 * @returns {Array} Price data points
 */
async function fetchAwattarPrices(config) {
  try {
    const countryDomain = config.country.toLowerCase() === 'at' ? 'at' : 'de';
    const url = `https://api.awattar.${countryDomain}/v1/marketdata`;
    
    const response = await axios.get(url, { timeout: 10000 });
    
    if (response.data && response.data.data) {
      return response.data.data.map(item => ({
        timestamp: moment(item.start_timestamp).toISOString(),
        price: item.marketprice / 1000, // Convert from EUR/MWh to EUR/kWh
        currency: 'EUR',
        unit: 'kWh'
      }));
    }
    
    return [];
  } catch (error) {
    console.error('Error fetching aWATTar prices:', error.message);
    return [];
  }
}

/**
 * Fetch prices from Nordpool API (Nordic and Baltic countries)
 * Note: Nordpool doesn't have a public API, this is a sample implementation using their website data
 * @param {Object} config - Configuration with country settings
 * @returns {Array} Price data points
 */
async function fetchNordpoolPrices(config) {
  try {
    // For a real implementation, you'd need to either:
    // 1. Use a commercial API service for Nordpool data
    // 2. Scrape the Nordpool website (with permission)
    // 3. Use a public dataset that includes Nordpool data
    
    // For now, we'll return sample data
    console.warn('Nordpool API not implemented, returning sample data');
    return generateSamplePriceData();
  } catch (error) {
    console.error('Error fetching Nordpool prices:', error.message);
    return [];
  }
}

/**
 * Fetch prices from Epex Spot (Central European power exchange)
 * @param {Object} config - Configuration with country settings
 * @returns {Array} Price data points
 */
async function fetchEpexSpotPrices(config) {
  try {
    // EPEX SPOT doesn't have a public API either
    // For a real implementation, you'd need to use a commercial data provider
    
    console.warn('EPEX Spot API not implemented, returning sample data');
    return generateSamplePriceData();
  } catch (error) {
    console.error('Error fetching EPEX Spot prices:', error.message);
    return [];
  }
}

/**
 * Generate sample price data for testing or fallback
 * @returns {Array} Sample price data points
 */
function generateSamplePriceData() {
  const prices = [];
  const now = moment().startOf('hour');
  
  // Generate 48 hourly price points (24 hours x 2 days)
  for (let i = 0; i < 48; i++) {
    const timestamp = moment(now).add(i, 'hours');
    
    // Create a realistic price pattern:
    // - Higher prices in morning (7-9) and evening (17-21)
    // - Lower prices at night and midday
    // - Weekend prices lower than weekday
    const hour = timestamp.hour();
    const isWeekend = timestamp.day() === 0 || timestamp.day() === 6;
    
    let basePrice = 0.10; // Base price in EUR/kWh
    
    if (hour >= 7 && hour <= 9) {
      // Morning peak
      basePrice = 0.18;
    } else if (hour >= 17 && hour <= 21) {
      // Evening peak
      basePrice = 0.20;
    } else if (hour >= 1 && hour <= 5) {
      // Night valley
      basePrice = 0.06;
    } else if (hour >= 11 && hour <= 14) {
      // Midday valley (solar production)
      basePrice = 0.08;
    }
    
    // Weekend discount
    if (isWeekend) {
      basePrice *= 0.8;
    }
    
    // Add some randomness (-15% to +15%)
    const randomFactor = 0.85 + (Math.random() * 0.3);
    const price = basePrice * randomFactor;
    
    prices.push({
      timestamp: timestamp.toISOString(),
      price: parseFloat(price.toFixed(4)),
      currency: 'EUR',
      unit: 'kWh'
    });
  }
  
  return prices;
}

/**
 * Main function to fetch electricity prices from the appropriate source
 * @param {Object} config - Configuration object with API settings
 * @returns {Array} Price data points
 */
async function fetchElectricityPrices(config) {
  // Nordpool is used in Nordic countries (NO, SE, FI, DK) and Baltics
  const nordpoolCountries = ['NO', 'SE', 'FI', 'DK', 'EE', 'LV', 'LT'];
  
  // AWATTAR is available in Germany and Austria
  const awattarCountries = ['DE', 'AT'];
  
  if (awattarCountries.includes(config.country)) {
    return await fetchAwattarPrices(config);
  } else if (nordpoolCountries.includes(config.country)) {
    return await fetchNordpoolPrices(config);
  } else {
    // Most European countries can use ENTSO-E
    return await fetchEntsoeElectricityPrices(config);
  }
}

module.exports = {
  fetchElectricityPrices,
  fetchEntsoeElectricityPrices,
  fetchAwattarPrices,
  fetchNordpoolPrices,
  fetchEpexSpotPrices,
  generateSamplePriceData
};