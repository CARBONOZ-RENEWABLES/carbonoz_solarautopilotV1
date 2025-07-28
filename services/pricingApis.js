// services/pricingApis.js - FIXED VERSION WITH EURO CURRENCY CONVERSION

const axios = require('axios');
const moment = require('moment-timezone');

// Tibber API endpoints
const TIBBER_API_URL = 'https://api.tibber.com/v1-beta/gql';

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

// FIXED: Currency conversion rates (approximate - for display purposes)
// In a production system, you'd fetch real-time exchange rates
const CURRENCY_TO_EUR_RATES = {
  'EUR': 1.000,
  'SEK': 0.088,   // 1 SEK ≈ 0.088 EUR
  'NOK': 0.086,   // 1 NOK ≈ 0.086 EUR
  'DKK': 0.134,   // 1 DKK ≈ 0.134 EUR
  'GBP': 1.170,   // 1 GBP ≈ 1.170 EUR
  'USD': 0.920    // 1 USD ≈ 0.920 EUR (fallback)
};

/**
 * FIXED: Convert price to EUR for consistent display
 * @param {number} price - Original price
 * @param {string} fromCurrency - Source currency
 * @returns {number} Price in EUR
 */
function convertToEUR(price, fromCurrency) {
  if (!price || typeof price !== 'number') return 0;
  
  const rate = CURRENCY_TO_EUR_RATES[fromCurrency?.toUpperCase()] || 1;
  const convertedPrice = price * rate;
  
  // Log conversion for debugging
  if (fromCurrency !== 'EUR') {
    console.log(`💱 Currency conversion: ${price} ${fromCurrency} → ${convertedPrice.toFixed(4)} EUR (rate: ${rate})`);
  }
  
  return convertedPrice;
}

/**
 * Fetch real-time electricity prices from Tibber API
 * @param {Object} config - Configuration object
 * @returns {Array} Array of price data with Tibber levels
 */
async function fetchTibberPrices(config) {
  try {
    if (!config.tibberApiKey || !config.tibberApiKey.trim()) {
      throw new Error('Tibber API key is required');
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

    const response = await axios.post(TIBBER_API_URL, {
      query: query
    }, {
      headers: {
        'Authorization': `Bearer ${config.tibberApiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });

    if (response.data.errors) {
      const error = response.data.errors[0];
      console.error('Tibber API Error:', error.message);
      throw new Error(`Tibber API Error: ${error.message}`);
    }

    const homes = response.data.data?.viewer?.homes;
    if (!homes || homes.length === 0) {
      throw new Error('No Tibber homes found in your account');
    }

    const priceInfo = homes[0].currentSubscription?.priceInfo;
    if (!priceInfo) {
      throw new Error('No price information available from Tibber');
    }

    const timezone = config.timezone || TIBBER_COUNTRY_TIMEZONES[config.country] || 'Europe/Berlin';
    const originalCurrency = priceInfo.current?.currency || 'EUR';

    // Combine today's and tomorrow's prices
    const allPrices = [...(priceInfo.today || []), ...(priceInfo.tomorrow || [])];
    
    const formattedPrices = allPrices.map(priceData => {
      // FIXED: Convert all prices to EUR for consistent display
      const originalPrice = priceData.total;
      const eurPrice = convertToEUR(originalPrice, originalCurrency);
      const eurEnergy = convertToEUR(priceData.energy, originalCurrency);
      const eurTax = convertToEUR(priceData.tax, originalCurrency);
      
      return {
        timestamp: moment(priceData.startsAt).tz(timezone).toISOString(),
        price: eurPrice, // FIXED: Always in EUR
        currency: 'EUR', // FIXED: Always display as EUR
        originalPrice: originalPrice,
        originalCurrency: originalCurrency,
        level: priceData.level, // Tibber price level (VERY_CHEAP, CHEAP, NORMAL, EXPENSIVE, VERY_EXPENSIVE)
        energy: eurEnergy,
        tax: eurTax,
        timezone: timezone,
        provider: 'Tibber',
        localHour: moment(priceData.startsAt).tz(timezone).hour()
      };
    });

    console.log(`✅ Retrieved ${formattedPrices.length} real-time price points from Tibber`);
    console.log(`💰 Current price: ${convertToEUR(priceInfo.current?.total, originalCurrency).toFixed(4)} EUR/kWh (Level: ${priceInfo.current?.level}) [Original: ${priceInfo.current?.total} ${originalCurrency}]`);

    return formattedPrices;
  } catch (error) {
    console.error('Error fetching Tibber prices:', error.message);
    throw error;
  }
}

/**
 * Get current real-time price from Tibber
 * @param {Object} config - Configuration object
 * @returns {Object} Current price information
 */
async function getTibberCurrentPrice(config) {
  try {
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

    const response = await axios.post(TIBBER_API_URL, {
      query: query
    }, {
      headers: {
        'Authorization': `Bearer ${config.tibberApiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    if (response.data.errors) {
      throw new Error(`Tibber API Error: ${response.data.errors[0].message}`);
    }

    const current = response.data.data?.viewer?.homes?.[0]?.currentSubscription?.priceInfo?.current;
    
    if (!current) {
      throw new Error('No current price available from Tibber');
    }

    // FIXED: Convert current price to EUR
    const originalCurrency = current.currency || 'EUR';
    const eurPrice = convertToEUR(current.total, originalCurrency);

    return {
      price: eurPrice, // FIXED: Always return EUR price
      level: current.level,
      currency: 'EUR', // FIXED: Always return EUR currency
      originalPrice: current.total,
      originalCurrency: originalCurrency,
      timestamp: current.startsAt,
      provider: 'Tibber Real-time',
      isRealTime: true
    };
  } catch (error) {
    console.error('Error getting current Tibber price:', error.message);
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
 * Test Tibber API connection
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

    const response = await axios.post(TIBBER_API_URL, {
      query: query
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    if (response.data.errors) {
      return {
        success: false,
        error: response.data.errors[0].message,
        details: 'Invalid API key or API error'
      };
    }

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
    
    // FIXED: Convert test price to EUR for consistent display
    let currentPrice = null;
    if (currentPriceRaw) {
      const originalCurrency = currentPriceRaw.currency || 'EUR';
      const eurPrice = convertToEUR(currentPriceRaw.total, originalCurrency);
      
      currentPrice = {
        price: eurPrice,
        currency: 'EUR', // FIXED: Always return EUR
        originalPrice: currentPriceRaw.total,
        originalCurrency: originalCurrency,
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
 * Generate sample data with realistic Nordic pricing patterns
 * @param {string} timezone - Timezone for data
 * @returns {Array} Sample price data
 */
function generateRealisticSampleData(timezone = 'Europe/Berlin') {
  const prices = [];
  const now = moment().tz(timezone);
  const startHour = now.clone().startOf('hour');

  // FIXED: Realistic European price patterns in EUR
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
      currency: 'EUR', // FIXED: Always use EUR for sample data
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

/**
 * FIXED: Get exchange rate for currency conversion (static rates for demo)
 * In production, you'd fetch from a real exchange rate API
 * @param {string} fromCurrency - Source currency
 * @param {string} toCurrency - Target currency
 * @returns {number} Exchange rate
 */
function getExchangeRate(fromCurrency, toCurrency = 'EUR') {
  if (fromCurrency === toCurrency) return 1;
  
  const rate = CURRENCY_TO_EUR_RATES[fromCurrency?.toUpperCase()];
  if (rate) {
    console.log(`💱 Exchange rate ${fromCurrency} → ${toCurrency}: ${rate}`);
    return rate;
  }
  
  console.warn(`⚠️ No exchange rate found for ${fromCurrency}, using 1:1`);
  return 1;
}

module.exports = {
  fetchElectricityPrices,
  fetchTibberPrices,
  getTibberCurrentPrice,
  getTibberCountriesAndCities,
  getLocationByCountryCity,
  testTibberConnection,
  generateRealisticSampleData,
  convertToEUR, // FIXED: Export conversion function
  getExchangeRate, // FIXED: Export exchange rate function
  TIBBER_COUNTRY_TIMEZONES,
  TIBBER_CITIES,
  CURRENCY_TO_EUR_RATES // FIXED: Export currency rates
};
