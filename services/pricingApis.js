// pricingApis.js - TIBBER API INTEGRATION

const axios = require('axios');
const moment = require('moment-timezone');

/**
 * Tibber supported countries with their configurations
 */
const TIBBER_COUNTRIES = {
  'NO': { timezone: 'Europe/Oslo', currency: 'NOK', market: 'TIBBER' },
  'SE': { timezone: 'Europe/Stockholm', currency: 'SEK', market: 'TIBBER' },
  'DK': { timezone: 'Europe/Copenhagen', currency: 'DKK', market: 'TIBBER' },
  'FI': { timezone: 'Europe/Helsinki', currency: 'EUR', market: 'TIBBER' },
  'DE': { timezone: 'Europe/Berlin', currency: 'EUR', market: 'TIBBER' },
  'NL': { timezone: 'Europe/Amsterdam', currency: 'EUR', market: 'TIBBER' }
};

/**
 * Tibber GraphQL API endpoint
 */
const TIBBER_API_URL = 'https://api.tibber.com/v1-beta/gql';

/**
 * GraphQL query for getting current and forecasted prices
 */
const TIBBER_PRICE_QUERY = `
  query {
    viewer {
      homes {
        currentSubscription {
          priceInfo {
            current {
              total
              energy
              tax
              startsAt
              level
            }
            today {
              total
              energy
              tax
              startsAt
              level
            }
            tomorrow {
              total
              energy
              tax
              startsAt
              level
            }
          }
        }
        address {
          address1
          postalCode
          city
          country
        }
        timeZone
      }
    }
  }
`;

/**
 * Fetch electricity prices from Tibber API
 */
async function fetchTibberElectricityPrices(config) {
  if (!config.apiKey) {
    throw new Error('Tibber API token is required');
  }
  
  try {
    console.log(`Fetching Tibber pricing data for ${config.country}...`);
    
    const response = await axios.post(TIBBER_API_URL, {
      query: TIBBER_PRICE_QUERY
    }, {
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'SolarAutopilot/1.0'
      },
      timeout: 30000
    });
    
    if (response.status !== 200) {
      throw new Error(`Tibber API returned status ${response.status}`);
    }
    
    const data = response.data;
    
    if (data.errors && data.errors.length > 0) {
      throw new Error(`Tibber API error: ${data.errors[0].message}`);
    }
    
    if (!data.data || !data.data.viewer || !data.data.viewer.homes || data.data.viewer.homes.length === 0) {
      throw new Error('No homes found in Tibber account or invalid API token');
    }
    
    const home = data.data.viewer.homes[0]; // Use first home
    const priceInfo = home.currentSubscription?.priceInfo;
    
    if (!priceInfo) {
      throw new Error('No price information available for this home');
    }
    
    // Get timezone from home data or use config
    const homeTimezone = home.timeZone || config.timezone;
    const countryConfig = TIBBER_COUNTRIES[config.country] || TIBBER_COUNTRIES['DE'];
    const timezone = homeTimezone || countryConfig.timezone;
    
    // Determine currency from home location
    const homeCurrency = determineCurrencyFromCountry(home.address?.country || config.country);
    
    const prices = [];
    
    // Process current price
    if (priceInfo.current) {
      prices.push(formatTibberPrice(priceInfo.current, timezone, homeCurrency));
    }
    
    // Process today's prices
    if (priceInfo.today && Array.isArray(priceInfo.today)) {
      priceInfo.today.forEach(price => {
        prices.push(formatTibberPrice(price, timezone, homeCurrency));
      });
    }
    
    // Process tomorrow's prices (if available)
    if (priceInfo.tomorrow && Array.isArray(priceInfo.tomorrow)) {
      priceInfo.tomorrow.forEach(price => {
        prices.push(formatTibberPrice(price, timezone, homeCurrency));
      });
    }
    
    // Remove duplicates and sort by timestamp
    const uniquePrices = prices
      .filter((price, index, self) => 
        index === self.findIndex(p => p.timestamp === price.timestamp)
      )
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    console.log(`✅ Tibber: Retrieved ${uniquePrices.length} real price points`);
    console.log(`Home location: ${home.address?.city}, ${home.address?.country}`);
    console.log(`Timezone: ${timezone}, Currency: ${homeCurrency}`);
    
    return uniquePrices;
    
  } catch (error) {
    console.error('Error fetching Tibber prices:', error.message);
    throw error;
  }
}

/**
 * Format Tibber price data to our standard format
 */
function formatTibberPrice(tibberPrice, timezone, currency) {
  return {
    timestamp: tibberPrice.startsAt,
    price: parseFloat((tibberPrice.total || 0).toFixed(4)),
    energy: parseFloat((tibberPrice.energy || 0).toFixed(4)),
    tax: parseFloat((tibberPrice.tax || 0).toFixed(4)),
    level: tibberPrice.level || 'NORMAL', // VERY_CHEAP, CHEAP, NORMAL, EXPENSIVE, VERY_EXPENSIVE
    currency: currency,
    unit: 'kWh',
    timezone: timezone,
    source: 'real',
    market: 'TIBBER'
  };
}

/**
 * Determine currency based on country
 */
function determineCurrencyFromCountry(country) {
  const currencyMap = {
    'NO': 'NOK',
    'SE': 'SEK', 
    'DK': 'DKK',
    'FI': 'EUR',
    'DE': 'EUR',
    'NL': 'EUR'
  };
  
  return currencyMap[country] || 'EUR';
}

/**
 * Generate sample price data for testing (Tibber-style)
 */
function generateTibberSampleData(countryCode = 'DE') {
  const prices = [];
  const countryConfig = TIBBER_COUNTRIES[countryCode] || TIBBER_COUNTRIES['DE'];
  const timezone = countryConfig.timezone;
  const currency = countryConfig.currency;
  
  const now = moment().tz(timezone).startOf('hour');
  
  // Country-specific price patterns (in local currency)
  const pricePatterns = {
    'NO': { base: 1.20, peak: 2.00, valley: 0.60 }, // NOK/kWh
    'SE': { base: 1.80, peak: 2.80, valley: 0.90 }, // SEK/kWh
    'DK': { base: 2.20, peak: 3.50, valley: 1.20 }, // DKK/kWh
    'FI': { base: 0.18, peak: 0.28, valley: 0.12 }, // EUR/kWh
    'DE': { base: 0.30, peak: 0.45, valley: 0.20 }, // EUR/kWh
    'NL': { base: 0.26, peak: 0.38, valley: 0.16 }  // EUR/kWh
  };
  
  const pattern = pricePatterns[countryCode] || pricePatterns['DE'];
  
  // Generate 48 hourly price points
  for (let i = 0; i < 48; i++) {
    const timestamp = moment(now).add(i, 'hours');
    
    const hour = timestamp.hour();
    const isWeekend = timestamp.day() === 0 || timestamp.day() === 6;
    
    let basePrice = pattern.base;
    let level = 'NORMAL';
    
    // Time-of-day pricing with Tibber-style levels
    if (hour >= 7 && hour <= 9) {
      basePrice = pattern.peak;
      level = 'EXPENSIVE';
    } else if (hour >= 17 && hour <= 21) {
      basePrice = pattern.peak;
      level = 'VERY_EXPENSIVE';
    } else if (hour >= 1 && hour <= 5) {
      basePrice = pattern.valley;
      level = 'VERY_CHEAP';
    } else if (hour >= 11 && hour <= 14) {
      basePrice = pattern.valley;
      level = 'CHEAP';
    }
    
    // Weekend patterns
    if (isWeekend) {
      basePrice *= 0.85;
      if (level === 'VERY_EXPENSIVE') level = 'EXPENSIVE';
      if (level === 'EXPENSIVE') level = 'NORMAL';
    }
    
    // Add market volatility
    const volatilityFactor = 0.8 + (Math.random() * 0.4);
    const finalPrice = basePrice * volatilityFactor;
    
    prices.push({
      timestamp: timestamp.toISOString(),
      price: parseFloat(finalPrice.toFixed(4)),
      energy: parseFloat((finalPrice * 0.7).toFixed(4)),
      tax: parseFloat((finalPrice * 0.3).toFixed(4)),
      level: level,
      currency: currency,
      unit: 'kWh',
      timezone: timezone,
      source: 'sample',
      market: 'TIBBER',
      country: countryCode
    });
  }
  
  return prices;
}

/**
 * Main function to fetch electricity prices - TIBBER FOCUSED (Real data only)
 */
async function fetchElectricityPrices(config) {
  const countryCode = config.country || 'DE';
  
  // Check if country is supported by Tibber
  if (!TIBBER_COUNTRIES[countryCode]) {
    throw new Error(`Country ${countryCode} not supported by Tibber`);
  }
  
  // Require API key for real data
  if (!config.apiKey || config.apiKey.trim() === '') {
    throw new Error('Tibber API token is required');
  }
  
  try {
    console.log(`Attempting to fetch REAL Tibber pricing data for ${countryCode}`);
    
    const prices = await fetchTibberElectricityPrices(config);
    
    // Validate we got data
    if (!prices || prices.length === 0) {
      throw new Error('No pricing data returned from Tibber API');
    }
    
    // Add metadata
    const enhancedPrices = prices.map(price => ({
      ...price,
      country: countryCode,
      operator: 'Tibber'
    }));
    
    console.log(`✅ Successfully fetched ${enhancedPrices.length} REAL price points from Tibber for ${countryCode}`);
    return enhancedPrices;
    
  } catch (error) {
    console.log(`❌ Tibber data fetch failed for ${countryCode}: ${error.message}`);
    throw error; // Don't fall back to sample data, throw the error
  }
}

/**
 * Determine low price periods using Tibber's price levels
 */
function determineLowPricePeriods(pricingData, config) {
  if (!pricingData || pricingData.length === 0) {
    return [];
  }
  
  try {
    // If Tibber data, use their price levels
    const hasTibberLevels = pricingData.some(p => p.level);
    
    if (hasTibberLevels) {
      // Use Tibber's built-in price levels
      const lowPricePeriods = pricingData.filter(p => 
        p.level === 'VERY_CHEAP' || p.level === 'CHEAP'
      );
      
      // Group consecutive periods
      return groupConsecutivePeriods(lowPricePeriods, config.timezone);
    }
    
    // Fallback to threshold-based calculation
    const threshold = config.priceThreshold > 0 
      ? config.priceThreshold 
      : calculateAutoThreshold(pricingData);
    
    const lowPricePeriods = pricingData.filter(p => p.price <= threshold);
    return groupConsecutivePeriods(lowPricePeriods, config.timezone);
    
  } catch (error) {
    console.error('Error determining low price periods:', error);
    return [];
  }
}

/**
 * Group consecutive price periods
 */
function groupConsecutivePeriods(periods, timezone = 'Europe/Berlin') {
  if (periods.length === 0) return [];
  
  const groupedPeriods = [];
  let currentGroup = null;
  
  periods.forEach(period => {
    const periodTime = moment(period.timestamp).tz(timezone);
    
    if (!currentGroup) {
      currentGroup = {
        start: period.timestamp,
        end: moment(periodTime).add(1, 'hour').toISOString(),
        avgPrice: period.price,
        level: period.level || 'LOW',
        timezone: timezone
      };
    } else {
      const currentEnd = moment(currentGroup.end).tz(timezone);
      
      if (periodTime.diff(currentEnd, 'hours') <= 1) {
        currentGroup.end = moment(periodTime).add(1, 'hour').toISOString();
        currentGroup.avgPrice = (currentGroup.avgPrice + period.price) / 2;
      } else {
        groupedPeriods.push(currentGroup);
        currentGroup = {
          start: period.timestamp,
          end: moment(periodTime).add(1, 'hour').toISOString(),
          avgPrice: period.price,
          level: period.level || 'LOW',
          timezone: timezone
        };
      }
    }
  });
  
  if (currentGroup) {
    groupedPeriods.push(currentGroup);
  }
  
  return groupedPeriods;
}

/**
 * Calculate automatic threshold (25% lowest prices)
 */
function calculateAutoThreshold(pricingData) {
  const prices = pricingData.map(p => p.price).sort((a, b) => a - b);
  const index = Math.floor(prices.length * 0.25);
  return prices[index] || 0.1;
}

/**
 * Get supported countries
 */
function getSupportedCountries() {
  return Object.keys(TIBBER_COUNTRIES).map(countryCode => ({
    code: countryCode,
    ...TIBBER_COUNTRIES[countryCode],
    name: getCountryName(countryCode)
  }));
}

/**
 * Get country name
 */
function getCountryName(countryCode) {
  const countryNames = {
    'NO': 'Norway',
    'SE': 'Sweden', 
    'DK': 'Denmark',
    'FI': 'Finland',
    'DE': 'Germany',
    'NL': 'Netherlands'
  };
  
  return countryNames[countryCode] || countryCode;
}

/**
 * Validate if country is supported by Tibber
 */
function isCountrySupported(countryCode) {
  return TIBBER_COUNTRIES.hasOwnProperty(countryCode);
}

/**
 * Get timezone for a country
 */
function getCountryTimezone(countryCode) {
  const config = TIBBER_COUNTRIES[countryCode];
  return config ? config.timezone : 'UTC';
}

module.exports = {
  fetchElectricityPrices,
  fetchTibberElectricityPrices,
  generateTibberSampleData,
  determineLowPricePeriods,
  getSupportedCountries,
  isCountrySupported,
  getCountryTimezone,
  TIBBER_COUNTRIES
};