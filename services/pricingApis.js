// services/pricingApis.js - FIXED VERSION WITH TIMEOUT HANDLING AND RETRY LOGIC

const axios = require('axios');
const moment = require('moment-timezone');
const fs = require('fs');
const path = require('path');

// Tibber API endpoints
const TIBBER_API_URL = 'https://api.tibber.com/v1-beta/gql';

// Circuit breaker for API health
const circuitBreaker = {
  failures: 0,
  lastFailure: null,
  isOpen: false,
  threshold: 3,
  timeout: 60000 // 1 minute cooldown
};

// Cache for API responses
const apiCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Country to timezone mapping for Tibber
const TIBBER_COUNTRY_TIMEZONES = {
  'NO': 'Europe/Oslo',      // Norway
  'SE': 'Europe/Stockholm', // Sweden
  'DK': 'Europe/Copenhagen',// Denmark
  'FI': 'Europe/Helsinki',  // Finland
  'DE': 'Europe/Berlin',    // Germany
  'NL': 'Europe/Amsterdam', // Netherlands
  'GB': 'Europe/London'     // United Kingdom
};

// Cities mapping for weather API
const TIBBER_CITIES = {
  'NO': [
    { name: 'Oslo', lat: 59.9139, lon: 10.7522 },
    { name: 'Bergen', lat: 60.3913, lon: 5.3221 },
    { name: 'Trondheim', lat: 63.4305, lon: 10.3951 },
    { name: 'Stavanger', lat: 58.9700, lon: 5.7331 }
  ],
  'SE': [
    { name: 'Stockholm', lat: 59.3293, lon: 18.0686 },
    { name: 'Göteborg', lat: 57.7089, lon: 11.9746 },
    { name: 'Malmö', lat: 55.6050, lon: 13.0038 },
    { name: 'Uppsala', lat: 59.8586, lon: 17.6389 }
  ],
  'DK': [
    { name: 'Copenhagen', lat: 55.6761, lon: 12.5683 },
    { name: 'Århus', lat: 56.1629, lon: 10.2039 },
    { name: 'Odense', lat: 55.4038, lon: 10.4024 },
    { name: 'Aalborg', lat: 57.0488, lon: 9.9217 }
  ],
  'FI': [
    { name: 'Helsinki', lat: 60.1699, lon: 24.9384 },
    { name: 'Espoo', lat: 60.2055, lon: 24.6559 },
    { name: 'Tampere', lat: 61.4991, lon: 23.7871 },
    { name: 'Vantaa', lat: 60.2934, lon: 25.0378 }
  ],
  'DE': [
    { name: 'Berlin', lat: 52.5200, lon: 13.4050 },
    { name: 'Hamburg', lat: 53.5511, lon: 9.9937 },
    { name: 'Munich', lat: 48.1351, lon: 11.5820 },
    { name: 'Cologne', lat: 50.9375, lon: 6.9603 },
    { name: 'Frankfurt', lat: 50.1109, lon: 8.6821 }
  ],
  'NL': [
    { name: 'Amsterdam', lat: 52.3676, lon: 4.9041 },
    { name: 'Rotterdam', lat: 51.9244, lon: 4.4777 },
    { name: 'The Hague', lat: 52.0705, lon: 4.3007 },
    { name: 'Utrecht', lat: 52.0907, lon: 5.1214 }
  ],
  'GB': [
    { name: 'London', lat: 51.5074, lon: -0.1278 },
    { name: 'Manchester', lat: 53.4808, lon: -2.2426 },
    { name: 'Birmingham', lat: 52.4862, lon: -1.8904 },
    { name: 'Leeds', lat: 53.8008, lon: -1.5491 }
  ]
};

/**
 * Check if circuit breaker should block requests
 */
function isCircuitOpen() {
  if (!circuitBreaker.isOpen) return false;
  
  const now = Date.now();
  const timeSinceLastFailure = now - circuitBreaker.lastFailure;
  
  if (timeSinceLastFailure > circuitBreaker.timeout) {
    // Reset circuit breaker
    circuitBreaker.isOpen = false;
    circuitBreaker.failures = 0;
    console.log('🔌 Circuit breaker reset - allowing requests');
    return false;
  }
  
  return true;
}

/**
 * Record API failure for circuit breaker
 */
function recordFailure() {
  circuitBreaker.failures++;
  circuitBreaker.lastFailure = Date.now();
  
  if (circuitBreaker.failures >= circuitBreaker.threshold) {
    circuitBreaker.isOpen = true;
    console.log('🔌 Circuit breaker OPEN - blocking requests for 1 minute');
  }
}

/**
 * Record API success
 */
function recordSuccess() {
  circuitBreaker.failures = 0;
  circuitBreaker.isOpen = false;
}

/**
 * Get from cache if available and not expired
 */
function getFromCache(key) {
  const cached = apiCache.get(key);
  if (!cached) return null;
  
  const now = Date.now();
  if (now - cached.timestamp > CACHE_DURATION) {
    apiCache.delete(key);
    return null;
  }
  
  console.log(`📦 Using cached data for ${key}`);
  return cached.data;
}

/**
 * Save to cache
 */
function saveToCache(key, data) {
  apiCache.set(key, {
    data: data,
    timestamp: Date.now()
  });
}

/**
 * Retry wrapper with exponential backoff
 */
async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 1000) {
  let lastError;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await fn();
      recordSuccess();
      return result;
    } catch (error) {
      lastError = error;
      console.log(`⚠️ Attempt ${i + 1}/${maxRetries} failed: ${error.message}`);
      
      if (i < maxRetries - 1) {
        const delay = initialDelay * Math.pow(2, i);
        console.log(`⏳ Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  recordFailure();
  throw lastError;
}

/**
 * Enhanced axios request with better timeout handling
 */
async function makeRobustRequest(url, options) {
  const timeout = options.timeout || 30000; // Default 30 seconds
  const controller = new AbortController();
  
  // Set up timeout
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeout);
  
  try {
    const response = await axios({
      ...options,
      url,
      signal: controller.signal,
      timeout: timeout,
      validateStatus: (status) => status < 500, // Don't throw on 4xx errors
      maxContentLength: 50 * 1024 * 1024, // 50MB
      maxBodyLength: 50 * 1024 * 1024
    });
    
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
      throw new Error(`Request timeout after ${timeout}ms - Tibber API may be slow or unreachable`);
    }
    
    throw error;
  }
}

/**
 * Fetch real-time electricity prices from Tibber API with enhanced error handling
 * @param {Object} config - Configuration object
 * @returns {Array} Array of price data with Tibber levels
 */
async function fetchTibberPrices(config) {
  try {
    if (!config.tibberApiKey || !config.tibberApiKey.trim()) {
      throw new Error('Tibber API key is required');
    }

    // Check circuit breaker
    if (isCircuitOpen()) {
      console.log('⚠️ Circuit breaker is open - using fallback data');
      const timezone = config.timezone || TIBBER_COUNTRY_TIMEZONES[config.country] || 'Europe/Berlin';
      return generateRealisticSampleData(timezone);
    }

    // Check cache first
    const cacheKey = `tibber_prices_${config.tibberApiKey.substring(0, 8)}`;
    const cached = getFromCache(cacheKey);
    if (cached) {
      return cached;
    }

    const query = `
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
                  currency
                  level
                }
                today {
                  total
                  energy
                  tax
                  startsAt
                  currency
                  level
                }
                tomorrow {
                  total
                  energy
                  tax
                  startsAt
                  currency
                  level
                }
              }
            }
          }
        }
      }
    `;

    console.log('🔋 Fetching real-time prices from Tibber API...');

    const fetchPrices = async () => {
      const response = await makeRobustRequest(TIBBER_API_URL, {
        method: 'POST',
        data: { query },
        headers: {
          'Authorization': `Bearer ${config.tibberApiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'SolarAutopilot/1.0'
        },
        timeout: 30000 // 30 seconds timeout
      });

      if (response.data.errors) {
        const error = response.data.errors[0];
        console.error('Tibber API Error:', error.message);
        throw new Error(`Tibber API Error: ${error.message}`);
      }

      return response;
    };

    const response = await retryWithBackoff(fetchPrices, 2, 2000);

    const homes = response.data.data?.viewer?.homes;
    if (!homes || homes.length === 0) {
      throw new Error('No Tibber homes found in your account');
    }

    const priceInfo = homes[0].currentSubscription?.priceInfo;
    if (!priceInfo) {
      throw new Error('No price information available from Tibber');
    }

    const timezone = config.timezone || TIBBER_COUNTRY_TIMEZONES[config.country] || 'Europe/Berlin';

    // Combine today's and tomorrow's prices
    const allPrices = [...(priceInfo.today || []), ...(priceInfo.tomorrow || [])];
    
    const formattedPrices = allPrices.map(priceData => ({
      timestamp: moment(priceData.startsAt).tz(timezone).toISOString(),
      price: priceData.total,
      currency: 'EUR',
      level: priceData.level,
      energy: priceData.energy,
      tax: priceData.tax,
      timezone: timezone,
      provider: 'Tibber',
      localHour: moment(priceData.startsAt).tz(timezone).hour()
    }));

    console.log(`✅ Retrieved ${formattedPrices.length} real-time price points from Tibber`);
    console.log(`💰 Current price: ${priceInfo.current?.total?.toFixed(4)} EUR/kWh (Level: ${priceInfo.current?.level})`);

    // Cache the results
    saveToCache(cacheKey, formattedPrices);

    return formattedPrices;
  } catch (error) {
    console.error('Error fetching Tibber prices:', error.message);
    
    // Return sample data as fallback
    const timezone = config.timezone || TIBBER_COUNTRY_TIMEZONES[config.country] || 'Europe/Berlin';
    console.log('📊 Using fallback sample data due to API error');
    return generateRealisticSampleData(timezone);
  }
}

/**
 * Get current real-time price from Tibber with enhanced error handling
 * @param {Object} config - Configuration object
 * @returns {Object} Current price information
 */
async function getTibberCurrentPrice(config) {
  try {
    // Check circuit breaker
    if (isCircuitOpen()) {
      console.log('⚠️ Circuit breaker is open - using cached or fallback data');
      
      // Try to get from persistent cache file
      const cacheFile = path.join(__dirname, '..', 'data', 'current_price_cache.json');
      if (fs.existsSync(cacheFile)) {
        try {
          const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
          if (cached && cached.price) {
            console.log('📦 Using persistent cached price');
            return cached.price;
          }
        } catch (e) {
          console.error('Failed to read price cache:', e);
        }
      }
      
      // Return a reasonable default
      return {
        price: 0.15,
        level: 'NORMAL',
        currency: 'EUR',
        timestamp: new Date().toISOString(),
        provider: 'Fallback',
        isRealTime: false
      };
    }

    // Check memory cache first
    const cacheKey = `tibber_current_${config.tibberApiKey.substring(0, 8)}`;
    const cached = getFromCache(cacheKey);
    if (cached) {
      return cached;
    }

    const query = `
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
                  currency
                  level
                }
              }
            }
          }
        }
      }
    `;

    const fetchCurrentPrice = async () => {
      const response = await makeRobustRequest(TIBBER_API_URL, {
        method: 'POST',
        data: { query },
        headers: {
          'Authorization': `Bearer ${config.tibberApiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'SolarAutopilot/1.0'
        },
        timeout: 20000 // 20 seconds timeout for current price
      });

      if (response.data.errors) {
        throw new Error(`Tibber API Error: ${response.data.errors[0].message}`);
      }

      return response;
    };

    const response = await retryWithBackoff(fetchCurrentPrice, 2, 1000);

    const current = response.data.data?.viewer?.homes?.[0]?.currentSubscription?.priceInfo?.current;
    
    if (!current) {
      throw new Error('No current price available from Tibber');
    }

    const priceData = {
      price: current.total,
      level: current.level,
      currency: 'EUR',
      timestamp: current.startsAt,
      provider: 'Tibber Real-time',
      isRealTime: true
    };

    // Cache the result
    saveToCache(cacheKey, priceData);

    return priceData;
  } catch (error) {
    console.error('Error getting current Tibber price:', error.message);
    
    // Try to get from persistent cache file as last resort
    const cacheFile = path.join(__dirname, '..', 'data', 'current_price_cache.json');
    if (fs.existsSync(cacheFile)) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        if (cached && cached.price) {
          console.log('📦 Using persistent cached price due to API error');
          return {
            ...cached.price,
            provider: 'Cached (API Error)',
            isRealTime: false
          };
        }
      } catch (e) {
        console.error('Failed to read price cache:', e);
      }
    }
    
    throw error;
  }
}

/**
 * Get supported Tibber countries and cities
 * @returns {Object} Countries and cities data
 */
function getTibberCountriesAndCities() {
  const countries = Object.keys(TIBBER_CITIES).map(code => ({
    code: code,
    name: getCountryName(code),
    timezone: TIBBER_COUNTRY_TIMEZONES[code],
    cities: TIBBER_CITIES[code]
  }));

  return {
    success: true,
    countries: countries,
    supported: Object.keys(TIBBER_CITIES)
  };
}

/**
 * Get country name from code
 */
function getCountryName(code) {
  const names = {
    'NO': 'Norway',
    'SE': 'Sweden', 
    'DK': 'Denmark',
    'FI': 'Finland',
    'DE': 'Germany',
    'NL': 'Netherlands',
    'GB': 'United Kingdom'
  };
  return names[code] || code;
}

/**
 * Get location coordinates by country and city
 * @param {string} country - Country code
 * @param {string} city - City name
 * @returns {Object} Coordinates
 */
function getLocationByCountryCity(country, city) {
  if (!TIBBER_CITIES[country]) {
    throw new Error(`Country ${country} not supported by Tibber`);
  }

  const cityData = TIBBER_CITIES[country].find(c => 
    c.name.toLowerCase() === city.toLowerCase()
  );

  if (!cityData) {
    // Return capital/first city as fallback
    return TIBBER_CITIES[country][0];
  }

  return cityData;
}

/**
 * Test Tibber API connection with timeout handling
 * @param {string} apiKey - Tibber API key
 * @returns {Object} Test result
 */
async function testTibberConnection(apiKey) {
  try {
    const query = `
      query {
        viewer {
          login
          userId
          name
          homes {
            id
            address {
              address1
              city
              country
            }
            currentSubscription {
              status
              priceInfo {
                current {
                  total
                  currency
                  level
                }
              }
            }
          }
        }
      }
    `;

    const testConnection = async () => {
      const response = await makeRobustRequest(TIBBER_API_URL, {
        method: 'POST',
        data: { query },
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'User-Agent': 'SolarAutopilot/1.0'
        },
        timeout: 15000 // 15 seconds for connection test
      });

      if (response.data.errors) {
        return {
          success: false,
          error: response.data.errors[0].message,
          details: 'Invalid API key or API error'
        };
      }

      return response;
    };

    const response = await retryWithBackoff(testConnection, 2, 1000);

    const viewer = response.data.data?.viewer;
    if (!viewer) {
      return {
        success: false,
        error: 'No viewer data returned',
        details: 'API key may be invalid'
      };
    }

    const homes = viewer.homes || [];
    const currentPriceRaw = homes[0]?.currentSubscription?.priceInfo?.current;
    
    let currentPrice = null;
    if (currentPriceRaw) {
      currentPrice = {
        price: currentPriceRaw.total,
        currency: 'EUR',
        level: currentPriceRaw.level
      };
    }

    return {
      success: true,
      user: {
        name: viewer.name,
        login: viewer.login,
        userId: viewer.userId
      },
      homes: homes.length,
      currentPrice: currentPrice,
      message: `Connected successfully. Found ${homes.length} home(s).`
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      details: 'Connection failed'
    };
  }
}

/**
 * Generate sample data with realistic European pricing patterns
 * @param {string} timezone - Timezone for data
 * @returns {Array} Sample price data
 */
function generateRealisticSampleData(timezone = 'Europe/Berlin') {
  const prices = [];
  const now = moment().tz(timezone);
  const startHour = now.clone().startOf('hour');

  // Realistic European price patterns in EUR
  const basePrices = {
    night: 0.08,    // 00:00 - 06:00
    morning: 0.15,  // 06:00 - 09:00  
    day: 0.12,      // 09:00 - 17:00
    evening: 0.18,  // 17:00 - 22:00
    late: 0.10      // 22:00 - 00:00
  };

  const levels = ['VERY_CHEAP', 'CHEAP', 'NORMAL', 'EXPENSIVE', 'VERY_EXPENSIVE'];

  for (let i = 0; i < 48; i++) {
    const timestamp = startHour.clone().add(i, 'hours');
    const hour = timestamp.hour();
    
    let basePrice;
    let level;
    
    if (hour >= 0 && hour < 6) {
      basePrice = basePrices.night;
      level = Math.random() < 0.7 ? 'VERY_CHEAP' : 'CHEAP';
    } else if (hour >= 6 && hour < 9) {
      basePrice = basePrices.morning;
      level = Math.random() < 0.5 ? 'NORMAL' : 'EXPENSIVE';
    } else if (hour >= 9 && hour < 17) {
      basePrice = basePrices.day;
      level = 'NORMAL';
    } else if (hour >= 17 && hour < 22) {
      basePrice = basePrices.evening;
      level = Math.random() < 0.6 ? 'EXPENSIVE' : 'VERY_EXPENSIVE';
    } else {
      basePrice = basePrices.late;
      level = Math.random() < 0.6 ? 'CHEAP' : 'NORMAL';
    }

    const randomFactor = 0.8 + (Math.random() * 0.4); // ±20% variation
    const price = basePrice * randomFactor;

    prices.push({
      timestamp: timestamp.toISOString(),
      price: parseFloat(price.toFixed(4)),
      currency: 'EUR',
      level: level,
      timezone: timezone,
      provider: 'Sample Data',
      localHour: hour,
      energy: parseFloat((price * 0.7).toFixed(4)), // Energy component
      tax: parseFloat((price * 0.3).toFixed(4))      // Tax component
    });
  }

  return prices;
}

/**
 * Main function to fetch electricity prices (enhanced with Tibber)
 * @param {Object} config - Configuration object
 * @returns {Array} Price data
 */
async function fetchElectricityPrices(config) {
  try {
    // If Tibber API key is provided, use real Tibber data
    if (config.tibberApiKey && config.tibberApiKey.trim()) {
      console.log('🔋 Using real-time Tibber API for pricing data...');
      return await fetchTibberPrices(config);
    }
    
    // Fallback to sample data
    console.log('🔋 Using sample pricing data (no Tibber API key provided)...');
    const timezone = config.timezone || TIBBER_COUNTRY_TIMEZONES[config.country] || 'Europe/Berlin';
    return generateRealisticSampleData(timezone);
  } catch (error) {
    console.error('Error fetching electricity prices:', error.message);
    
    // Fallback to sample data on error
    console.log('🔋 Falling back to sample pricing data due to error...');
    const timezone = config.timezone || TIBBER_COUNTRY_TIMEZONES[config.country] || 'Europe/Berlin';
    return generateRealisticSampleData(timezone);
  }
}

// Clear cache periodically (every hour)
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of apiCache.entries()) {
    if (now - value.timestamp > CACHE_DURATION) {
      apiCache.delete(key);
    }
  }
}, 60 * 60 * 1000);

module.exports = {
  fetchElectricityPrices,
  fetchTibberPrices,
  getTibberCurrentPrice,
  getTibberCountriesAndCities,
  getLocationByCountryCity,
  testTibberConnection,
  generateRealisticSampleData,
  TIBBER_COUNTRY_TIMEZONES,
  TIBBER_CITIES
};
