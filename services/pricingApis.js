// pricingApis.js - ENHANCED WITH REAL DATA FETCHING

const axios = require('axios');
const moment = require('moment-timezone');

/**
 * Global country configuration with timezones and market operators
 */
const COUNTRY_CONFIG = {
  // Europe
  'DE': { timezone: 'Europe/Berlin', market: 'AWATTAR', currency: 'EUR', operator: 'aWATTar' },
  'FR': { timezone: 'Europe/Paris', market: 'ENTSO-E', currency: 'EUR', operator: 'ENTSO-E' },
  'ES': { timezone: 'Europe/Madrid', market: 'ENTSO-E', currency: 'EUR', operator: 'ENTSO-E' },
  'IT': { timezone: 'Europe/Rome', market: 'ENTSO-E', currency: 'EUR', operator: 'ENTSO-E' },
  'UK': { timezone: 'Europe/London', market: 'ENTSO-E', currency: 'GBP', operator: 'National Grid ESO' },
  'NL': { timezone: 'Europe/Amsterdam', market: 'ENTSO-E', currency: 'EUR', operator: 'ENTSO-E' },
  'BE': { timezone: 'Europe/Brussels', market: 'ENTSO-E', currency: 'EUR', operator: 'ENTSO-E' },
  'AT': { timezone: 'Europe/Vienna', market: 'AWATTAR', currency: 'EUR', operator: 'aWATTar' },
  'CH': { timezone: 'Europe/Zurich', market: 'ENTSO-E', currency: 'CHF', operator: 'Swissgrid' },
  'DK': { timezone: 'Europe/Copenhagen', market: 'NORDPOOL', currency: 'DKK', operator: 'Nordpool' },
  'NO': { timezone: 'Europe/Oslo', market: 'NORDPOOL', currency: 'NOK', operator: 'Nordpool' },
  'SE': { timezone: 'Europe/Stockholm', market: 'NORDPOOL', currency: 'SEK', operator: 'Nordpool' },
  'FI': { timezone: 'Europe/Helsinki', market: 'NORDPOOL', currency: 'EUR', operator: 'Nordpool' },
  'PL': { timezone: 'Europe/Warsaw', market: 'ENTSO-E', currency: 'PLN', operator: 'ENTSO-E' },
  'CZ': { timezone: 'Europe/Prague', market: 'ENTSO-E', currency: 'CZK', operator: 'ENTSO-E' },
  'SK': { timezone: 'Europe/Bratislava', market: 'ENTSO-E', currency: 'EUR', operator: 'ENTSO-E' },
  'HU': { timezone: 'Europe/Budapest', market: 'ENTSO-E', currency: 'HUF', operator: 'ENTSO-E' },
  'RO': { timezone: 'Europe/Bucharest', market: 'ENTSO-E', currency: 'RON', operator: 'ENTSO-E' },
  'BG': { timezone: 'Europe/Sofia', market: 'ENTSO-E', currency: 'BGN', operator: 'ENTSO-E' },
  'GR': { timezone: 'Europe/Athens', market: 'ENTSO-E', currency: 'EUR', operator: 'ENTSO-E' },
  'PT': { timezone: 'Europe/Lisbon', market: 'ENTSO-E', currency: 'EUR', operator: 'ENTSO-E' },
  'IE': { timezone: 'Europe/Dublin', market: 'SEMO', currency: 'EUR', operator: 'SEMO' },
  'EE': { timezone: 'Europe/Tallinn', market: 'NORDPOOL', currency: 'EUR', operator: 'Nordpool' },
  'LV': { timezone: 'Europe/Riga', market: 'NORDPOOL', currency: 'EUR', operator: 'Nordpool' },
  'LT': { timezone: 'Europe/Vilnius', market: 'NORDPOOL', currency: 'EUR', operator: 'Nordpool' },
  
  // Additional countries
  'US': { timezone: 'America/New_York', market: 'PJM', currency: 'USD', operator: 'PJM/CAISO/ERCOT' },
  'CA': { timezone: 'America/Toronto', market: 'IESO', currency: 'CAD', operator: 'IESO/AESO' },
  'AU': { timezone: 'Australia/Sydney', market: 'AEMO', currency: 'AUD', operator: 'AEMO' },
  'NZ': { timezone: 'Pacific/Auckland', market: 'EA', currency: 'NZD', operator: 'Electricity Authority' },
  'JP': { timezone: 'Asia/Tokyo', market: 'JEPX', currency: 'JPY', operator: 'JEPX' }
};

/**
 * ENTSO-E area codes for European countries
 */
const ENTSO_E_AREA_CODES = {
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
  'PT': '10YPT-REN------W', // Portugal
  'IE': '10Y1001A1001A59C', // Ireland
  'EE': '10Y1001A1001A39I', // Estonia
  'LV': '10YLV-1001A00074', // Latvia
  'LT': '10YLT-1001A0008Q', // Lithuania
};

/**
 * Fetch electricity prices from ENTSO-E API - REAL DATA
 */
async function fetchEntsoeElectricityPrices(config) {
  if (!config.apiKey) {
    throw new Error('API key for ENTSO-E is missing');
  }
  
  try {
    const countryConfig = COUNTRY_CONFIG[config.country] || COUNTRY_CONFIG['DE'];
    const timezone = countryConfig.timezone;
    
    // Get today and tomorrow in the target timezone
    const today = moment().tz(timezone).format('YYYYMMDD');
    const tomorrow = moment().tz(timezone).add(1, 'day').format('YYYYMMDD');
    
    const areaCode = ENTSO_E_AREA_CODES[config.country];
    if (!areaCode) {
      throw new Error(`No ENTSO-E area code found for country: ${config.country}`);
    }
    
    const url = `https://web-api.tp.entsoe.eu/api`;
    const params = {
      documentType: 'A44',
      in_Domain: areaCode,
      out_Domain: areaCode,
      periodStart: today + '0000',
      periodEnd: tomorrow + '2300',
      securityToken: config.apiKey
    };
    
    console.log(`Fetching ENTSO-E data for ${config.country} from ${today} to ${tomorrow}`);
    
    const response = await axios.get(url, { 
      params: params,
      headers: { 
        'Content-Type': 'application/xml',
        'User-Agent': 'SolarAutopilot/1.0'
      },
      timeout: 30000
    });
    
    if (response.status !== 200) {
      throw new Error(`ENTSO-E API returned status ${response.status}`);
    }
    
    const parsedData = parseEntsoeXmlResponse(response.data, timezone, countryConfig.currency);
    
    if (parsedData.length === 0) {
      throw new Error('No pricing data returned from ENTSO-E API');
    }
    
    console.log(`✅ ENTSO-E: Retrieved ${parsedData.length} real price points for ${config.country}`);
    return parsedData;
    
  } catch (error) {
    console.error('Error fetching ENTSO-E electricity prices:', error.message);
    throw error; // Re-throw to allow fallback to sample data
  }
}

/**
 * Parse ENTSO-E XML response with timezone support
 */
function parseEntsoeXmlResponse(xmlData, timezone, currency) {
  try {
    const prices = [];
    
    // Extract time period
    const timePeriodPattern = /<time_Period>\s*<timeInterval>\s*<start>(.*?)<\/start>\s*<end>(.*?)<\/end>\s*<\/timeInterval>/s;
    const timePeriodMatch = xmlData.match(timePeriodPattern);
    
    if (!timePeriodMatch) {
      throw new Error('Failed to extract time period from ENTSO-E response');
    }
    
    const startTime = moment.tz(timePeriodMatch[1], timezone);
    
    // Extract price points
    const pointPattern = /<Point>\s*<position>(.*?)<\/position>\s*<price\.amount>(.*?)<\/price\.amount>\s*<\/Point>/g;
    let pointMatch;
    
    while ((pointMatch = pointPattern.exec(xmlData)) !== null) {
      const position = parseInt(pointMatch[1]);
      const priceAmount = parseFloat(pointMatch[2]);
      
      // Convert from EUR/MWh to local currency per kWh
      const pricePerKwh = priceAmount / 1000;
      
      const timestamp = moment(startTime).add(position - 1, 'hours');
      
      prices.push({
        timestamp: timestamp.toISOString(),
        price: parseFloat(pricePerKwh.toFixed(4)),
        currency: currency,
        unit: 'kWh',
        timezone: timezone,
        source: 'real',
        market: 'ENTSO-E'
      });
    }
    
    return prices;
  } catch (error) {
    console.error('Error parsing ENTSO-E XML response:', error.message);
    throw error;
  }
}

/**
 * Fetch prices from AWATTAR API (Germany and Austria) - REAL DATA
 */
async function fetchAwattarPrices(config) {
  try {
    const countryConfig = COUNTRY_CONFIG[config.country];
    const countryDomain = config.country.toLowerCase() === 'at' ? 'at' : 'de';
    const url = `https://api.awattar.${countryDomain}/v1/marketdata`;
    
    console.log(`Fetching aWATTar data for ${config.country} from ${url}`);
    
    const response = await axios.get(url, { 
      timeout: 15000,
      headers: {
        'User-Agent': 'SolarAutopilot/1.0'
      }
    });
    
    if (!response.data || !response.data.data) {
      throw new Error('Invalid response from aWATTar API');
    }
    
    const prices = response.data.data.map(item => ({
      timestamp: moment(item.start_timestamp).tz(countryConfig.timezone).toISOString(),
      price: parseFloat((item.marketprice / 1000).toFixed(4)), // Convert from EUR/MWh to EUR/kWh
      currency: countryConfig.currency,
      unit: 'kWh',
      timezone: countryConfig.timezone,
      source: 'real',
      market: 'aWATTar'
    }));
    
    console.log(`✅ aWATTar: Retrieved ${prices.length} real price points for ${config.country}`);
    return prices;
    
  } catch (error) {
    console.error('Error fetching aWATTar prices:', error.message);
    throw error; // Re-throw to allow fallback to sample data
  }
}

/**
 * Generate sample price data for testing or fallback
 */
function generateSamplePriceData(countryCode = 'DE') {
  const prices = [];
  const countryConfig = COUNTRY_CONFIG[countryCode] || COUNTRY_CONFIG['DE'];
  const timezone = countryConfig.timezone;
  const currency = countryConfig.currency;
  
  const now = moment().tz(timezone).startOf('hour');
  
  // Country-specific price patterns
  const pricePatterns = {
    'DE': { base: 0.30, peak: 0.45, valley: 0.20 },
    'AT': { base: 0.28, peak: 0.42, valley: 0.18 },
    'FR': { base: 0.25, peak: 0.35, valley: 0.15 },
    'UK': { base: 0.22, peak: 0.32, valley: 0.14 },
    'NL': { base: 0.26, peak: 0.38, valley: 0.16 },
    'BE': { base: 0.24, peak: 0.36, valley: 0.14 },
    'ES': { base: 0.20, peak: 0.28, valley: 0.12 },
    'IT': { base: 0.22, peak: 0.30, valley: 0.14 },
    'NO': { base: 0.15, peak: 0.20, valley: 0.08 },
    'SE': { base: 0.18, peak: 0.25, valley: 0.10 },
    'FI': { base: 0.16, peak: 0.22, valley: 0.12 },
    'DK': { base: 0.28, peak: 0.42, valley: 0.18 }
  };
  
  const pattern = pricePatterns[countryCode] || pricePatterns['DE'];
  
  // Generate 48 hourly price points
  for (let i = 0; i < 48; i++) {
    const timestamp = moment(now).add(i, 'hours');
    
    const hour = timestamp.hour();
    const isWeekend = timestamp.day() === 0 || timestamp.day() === 6;
    
    let basePrice = pattern.base;
    
    // Time-of-day pricing
    if (hour >= 7 && hour <= 9) {
      basePrice = pattern.peak; // Morning peak
    } else if (hour >= 17 && hour <= 21) {
      basePrice = pattern.peak; // Evening peak  
    } else if (hour >= 1 && hour <= 5) {
      basePrice = pattern.valley; // Night valley
    } else if (hour >= 11 && hour <= 14) {
      basePrice = pattern.valley; // Midday valley
    }
    
    // Weekend patterns
    if (isWeekend) {
      basePrice *= 0.85;
    }
    
    // Add market volatility
    const volatilityFactor = 0.8 + (Math.random() * 0.4);
    const finalPrice = basePrice * volatilityFactor;
    
    prices.push({
      timestamp: timestamp.toISOString(),
      price: parseFloat(finalPrice.toFixed(4)),
      currency: currency,
      unit: 'kWh',
      timezone: timezone,
      source: 'sample',
      market: countryConfig.operator
    });
  }
  
  return prices;
}

/**
 * Main function to fetch electricity prices - ENHANCED WITH REAL DATA SUPPORT
 */
async function fetchElectricityPrices(config) {
  const countryCode = config.country || 'DE';
  const countryConfig = COUNTRY_CONFIG[countryCode];
  
  if (!countryConfig) {
    console.warn(`Country ${countryCode} not supported, using sample data`);
    return generateSamplePriceData(countryCode);
  }
  
  let prices = [];
  
  try {
    console.log(`Attempting to fetch REAL pricing data for ${countryCode} using ${countryConfig.market}`);
    
    // Route to appropriate market API based on country configuration
    switch (countryConfig.market) {
      case 'AWATTAR':
        // aWATTar doesn't require API key for basic access
        prices = await fetchAwattarPrices(config);
        break;
        
      case 'ENTSO-E':
        // ENTSO-E requires API key
        if (!config.apiKey || config.apiKey.trim() === '') {
          throw new Error('ENTSO-E requires API key');
        }
        prices = await fetchEntsoeElectricityPrices(config);
        break;
        
      case 'NORDPOOL':
        // For now, use sample data (could implement Nordpool API)
        throw new Error('Nordpool API not implemented yet');
        
      default:
        throw new Error(`Market ${countryConfig.market} not implemented yet`);
    }
    
    // Validate we got data
    if (!prices || prices.length === 0) {
      throw new Error('No pricing data returned from API');
    }
    
    // Add metadata
    prices = prices.map(price => ({
      ...price,
      country: countryCode,
      market: countryConfig.market,
      operator: countryConfig.operator
    }));
    
    console.log(`✅ Successfully fetched ${prices.length} REAL price points for ${countryCode} from ${countryConfig.market}`);
    return prices;
    
  } catch (error) {
    console.log(`❌ Real data fetch failed for ${countryCode}: ${error.message}`);
    console.log(`Falling back to sample data for ${countryCode}`);
    
    // Fallback to sample data
    const samplePrices = generateSamplePriceData(countryCode);
    
    // Add metadata to sample data
    return samplePrices.map(price => ({
      ...price,
      country: countryCode,
      market: countryConfig.market,
      operator: countryConfig.operator
    }));
  }
}

/**
 * Get supported countries and their market information
 */
function getSupportedCountries() {
  return Object.keys(COUNTRY_CONFIG).map(countryCode => ({
    code: countryCode,
    ...COUNTRY_CONFIG[countryCode]
  }));
}

/**
 * Validate country code and configuration
 */
function isCountrySupported(countryCode) {
  return COUNTRY_CONFIG.hasOwnProperty(countryCode);
}

/**
 * Get timezone for a country
 */
function getCountryTimezone(countryCode) {
  const config = COUNTRY_CONFIG[countryCode];
  return config ? config.timezone : 'UTC';
}

/**
 * Get market operator for a country
 */
function getMarketOperator(countryCode) {
  const config = COUNTRY_CONFIG[countryCode];
  return config ? config.operator : 'Unknown';
}

module.exports = {
  fetchElectricityPrices,
  fetchEntsoeElectricityPrices,
  fetchAwattarPrices,
  generateSamplePriceData,
  getSupportedCountries,
  isCountrySupported,
  getCountryTimezone,
  getMarketOperator,
  COUNTRY_CONFIG,
  ENTSO_E_AREA_CODES
};
