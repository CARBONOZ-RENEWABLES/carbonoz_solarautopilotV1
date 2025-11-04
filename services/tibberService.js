const axios = require('axios');
const fs = require('fs');
const path = require('path');

class TibberService {
  constructor() {
    this.apiUrl = 'https://api.tibber.com/v1-beta/gql';
    this.configFile = path.join(__dirname, '../data/tibber_config.json');
    this.config = this.loadConfig();
    this.cache = {
      currentPrice: null,
      priceInfo: null,
      forecast: [],
      consumption: null,
      timestamp: null
    };
    this.lastUpdate = null;
    this.retryAttempts = 3;
    this.retryDelay = 2000;
    this.influxCacheLoaded = false;
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configFile)) {
        const fileContent = fs.readFileSync(this.configFile, 'utf8');
        
        try {
          const parsed = JSON.parse(fileContent);
          console.log('✅ Loaded valid Tibber config');
          return parsed;
        } catch (jsonError) {
          console.error('❌ Tibber config JSON is corrupted:', jsonError.message);
          console.log('🔧 Creating backup and using defaults...');
          
          const backupFile = this.configFile + '.corrupted.' + Date.now();
          fs.writeFileSync(backupFile, fileContent);
          console.log(`💾 Corrupted file backed up to: ${backupFile}`);
        }
      }
    } catch (error) {
      console.error('Error loading Tibber config:', error);
    }
    
    const defaultConfig = {
      enabled: false,
      apiKey: '',
      homeId: '',
      country: 'DE',
      timezone: 'Europe/Berlin',
      currency: 'EUR',
      targetSoC: 80,
      minimumSoC: 20,
      maxPriceThreshold: null,
      usePriceLevels: true,
      allowedPriceLevels: ['VERY_CHEAP', 'CHEAP', 'NORMAL']
    };
    
    try {
      this.saveConfigSync(defaultConfig);
      console.log('✅ Created fresh config with Germany defaults');
    } catch (saveError) {
      console.error('⚠️  Could not save default config:', saveError.message);
    }
    
    return defaultConfig;
  }

  // Initialize InfluxDB cache - call this after global.influx is available
  async initializeInfluxCache() {
    if (this.influxCacheLoaded) {
      console.log('ℹ️  Tibber InfluxDB cache already loaded');
      return;
    }

    try {
      const influxCache = await this.loadCacheFromInfluxDB();
      if (influxCache) {
        this.cache = influxCache;
        this.influxCacheLoaded = true;
        console.log('✅ Loaded Tibber cache from InfluxDB');
      } else {
        console.log('ℹ️  No Tibber cache found in InfluxDB - starting fresh');
      }
    } catch (error) {
      console.error('Error initializing Tibber InfluxDB cache:', error.message);
    }
  }

  loadCache() {
    this.loadCacheFromInfluxDB().then(influxCache => {
      if (influxCache) {
        this.cache = influxCache;
        console.log('✅ Loaded Tibber cache from InfluxDB');
      }
    }).catch(error => {
      console.error('Error loading Tibber cache from InfluxDB:', error);
    });
    
    return {
      currentPrice: null,
      priceInfo: null,
      forecast: [],
      consumption: null,
      timestamp: null
    };
  }
  
  async loadCacheFromInfluxDB() {
    try {
      if (!global.influx) {
        console.log('ℹ️  InfluxDB not initialized yet - Tibber cache will load after InfluxDB is ready');
        return null;
      }

      // Test connection first
      try {
        await global.influx.ping(5000);
      } catch (pingError) {
        console.warn('⚠️  InfluxDB connection unavailable - Tibber using local cache only');
        return null;
      }

      console.log('📊 Querying InfluxDB for Tibber cache...');

      const currentPriceQuery = `
        SELECT last("total") as total, last("energy") as energy, last("tax") as tax, last("level") as level, last("currency") as currency
        FROM "tibber_prices" 
        WHERE "type" = 'current' AND time > now() - 1h
      `;
      
      const forecastQuery = `
        SELECT "total", "energy", "tax", "level", "currency"
        FROM "tibber_forecast" 
        WHERE time > now() - 2h AND time < now() + 48h
        ORDER BY time ASC
      `;
      
      const [currentResult, forecastResult] = await Promise.all([
        global.influx.query(currentPriceQuery),
        global.influx.query(forecastQuery)
      ]);
      
      if (currentResult.length === 0) {
        console.log('ℹ️  No current price data found in InfluxDB');
        return null;
      }
      
      const currentPrice = currentResult[0];
      const forecast = forecastResult.map(row => ({
        total: row.total,
        energy: row.energy,
        tax: row.tax,
        level: row.level,
        currency: row.currency,
        startsAt: row.time
      }));
      
      console.log(`✅ Loaded Tibber cache from InfluxDB: current price + ${forecast.length} forecast points`);
      
      return {
        currentPrice: {
          total: currentPrice.total * 100,
          energy: currentPrice.energy * 100,
          tax: currentPrice.tax * 100,
          level: currentPrice.level,
          currency: 'cent',
          startsAt: currentPrice.time
        },
        priceInfo: null,
        forecast: forecast.map(price => ({
          ...price,
          total: price.total * 100,
          energy: price.energy * 100,
          tax: price.tax * 100,
          currency: 'cent'
        })),
        consumption: null,
        timestamp: Date.now()
      };
    } catch (error) {
      const errorMessage = error.message || error.toString();
      
      if (error.code === 'ECONNREFUSED' || 
          errorMessage.includes('ECONNREFUSED') ||
          errorMessage.includes('No host available') ||
          errorMessage.includes('connect ECONNREFUSED') ||
          errorMessage.includes('timeout')) {
        console.warn('⚠️  InfluxDB service unavailable - Tibber using local cache only');
        console.warn('💡 Tip: Start InfluxDB service or the application will work without it');
      } else {
        console.error('❌ Error loading Tibber cache from InfluxDB:', errorMessage);
      }
      return null;
    }
  }

  saveConfigSync(config) {
    const dataDir = path.dirname(this.configFile);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    fs.writeFileSync(this.configFile, JSON.stringify(config, null, 2));
  }

  saveConfig() {
    try {
      const dataDir = path.dirname(this.configFile);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      
      fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2));
      console.log('✅ Tibber config saved successfully');
    } catch (error) {
      console.error('Error saving Tibber config:', error);
    }
  }

  async saveCache() {
    try {
      await this.saveCacheToInfluxDB();
      this.cache.timestamp = Date.now();
    } catch (error) {
      console.error('Error saving Tibber cache:', error);
    }
  }

  async saveCacheToInfluxDB() {
    try {
      // Check if InfluxDB is available and properly initialized
      if (!global.influx) {
        console.warn('⚠️  InfluxDB not available for Tibber cache - using local storage only');
        return;
      }

      // Test connection before attempting to write
      try {
        await global.influx.ping(5000); // 5 second timeout
      } catch (pingError) {
        console.warn('⚠️  InfluxDB connection test failed - skipping Tibber cache save');
        return;
      }

      const points = [];
      
      if (this.cache.currentPrice) {
        points.push({
          measurement: 'tibber_prices',
          tags: {
            type: 'current',
            level: this.cache.currentPrice.level || 'NORMAL',
            currency: 'EUR'
          },
          fields: {
            total: (this.cache.currentPrice.total || 0) / 100,
            energy: (this.cache.currentPrice.energy || 0) / 100,
            tax: (this.cache.currentPrice.tax || 0) / 100
          },
          timestamp: new Date(this.cache.currentPrice.startsAt || Date.now())
        });
      }
      
      if (this.cache.forecast && this.cache.forecast.length > 0) {
        this.cache.forecast.forEach(price => {
          points.push({
            measurement: 'tibber_forecast',
            tags: {
              level: price.level || 'NORMAL',
              currency: 'EUR'
            },
            fields: {
              total: (price.total || 0) / 100,
              energy: (price.energy || 0) / 100,
              tax: (price.tax || 0) / 100
            },
            timestamp: new Date(price.startsAt)
          });
        });
      }
      
      if (points.length > 0) {
        await global.influx.writePoints(points);
        console.log(`✅ Saved ${points.length} Tibber data points to InfluxDB`);
      }
    } catch (error) {
      // More comprehensive error handling
      const errorMessage = error.message || error.toString();
      
      if (error.code === 'ECONNREFUSED' || 
          errorMessage.includes('ECONNREFUSED') ||
          errorMessage.includes('No host available') ||
          errorMessage.includes('connect ECONNREFUSED') ||
          errorMessage.includes('timeout')) {
        console.warn('⚠️  InfluxDB service unavailable - Tibber data stored locally only');
        console.warn('💡 Tip: Start InfluxDB service or the application will work without it');
      } else {
        console.error('❌ Error saving Tibber cache to InfluxDB:', errorMessage);
      }
    }
  }

  updateConfig(newConfig) {
    console.log('\n🔧 === UPDATE CONFIG CALLED ===');
    console.log('📥 Received config update:', {
      enabled: newConfig.enabled,
      hasApiKey: !!newConfig.apiKey,
      apiKeyPreview: newConfig.apiKey ? 
        `${newConfig.apiKey.substring(0, 10)}...${newConfig.apiKey.substring(newConfig.apiKey.length - 5)}` : 
        'none',
      apiKeyLength: newConfig.apiKey ? newConfig.apiKey.length : 0,
      homeId: newConfig.homeId || 'none',
      country: newConfig.country,
      timezone: newConfig.timezone,
      currency: newConfig.currency
    });
    
    // CRITICAL: Handle API key with ZERO processing
    if (newConfig.apiKey === '***' || newConfig.apiKey === '******') {
      console.log('⚠️  Skipping masked API key placeholder');
      delete newConfig.apiKey;
    } else if (newConfig.apiKey === '') {
      console.log('ℹ️  Empty API key - keeping existing');
      delete newConfig.apiKey;
    } else if (newConfig.apiKey && typeof newConfig.apiKey === 'string') {
      // CRITICAL: Save EXACTLY as received - NO TRIM, NO VALIDATION
      const rawKey = newConfig.apiKey;
      
      console.log('✅ API key received:');
      console.log('   - Length:', rawKey.length);
      console.log('   - First 10 chars:', rawKey.substring(0, 10));
      console.log('   - Last 10 chars:', rawKey.substring(rawKey.length - 10));
      console.log('   - Contains spaces:', rawKey.includes(' '));
      console.log('   - Type:', typeof rawKey);
      
      // SAVE RAW - NO PROCESSING AT ALL
      newConfig.apiKey = rawKey;
      
      console.log('💾 Saving API key exactly as received (no trim, no validation)');
    }
    
    // Auto-fill currency based on country if country is provided
    if (newConfig.country && !newConfig.currency) {
      const countryData = this.getCountrySettings(newConfig.country);
      if (countryData) {
        newConfig.currency = countryData.currency;
        console.log(`✅ Auto-filled currency: ${newConfig.currency} for ${newConfig.country}`);
      }
    }
    
    // Merge with existing config
    this.config = { ...this.config, ...newConfig };
    
    // Save to file
    this.saveConfig();
    
    // Verify what was saved
    console.log('\n✅ Config updated and saved:');
    console.log('   - Enabled:', this.config.enabled);
    console.log('   - API Key length:', this.config.apiKey ? this.config.apiKey.length : 0);
    console.log('   - API Key preview:', this.config.apiKey ? 
      `${this.config.apiKey.substring(0, 10)}...${this.config.apiKey.substring(this.config.apiKey.length - 5)}` : 
      'none');
    console.log('   - Home ID:', this.config.homeId || 'none');
    console.log('   - Country:', this.config.country);
    console.log('   - Timezone:', this.config.timezone);
    console.log('   - Currency:', this.config.currency);
    console.log('===========================\n');
    
    return this.config;
  }

  getSupportedCountries() {
    return [
      { code: 'NO', name: 'Norway', timezone: 'Europe/Oslo', currency: 'NOK', flag: '🇳🇴' },
      { code: 'SE', name: 'Sweden', timezone: 'Europe/Stockholm', currency: 'EUR', flag: '🇸🇪' },
      { code: 'DK', name: 'Denmark', timezone: 'Europe/Copenhagen', currency: 'DKK', flag: '🇩🇰' },
      { code: 'FI', name: 'Finland', timezone: 'Europe/Helsinki', currency: 'EUR', flag: '🇫🇮' },
      { code: 'DE', name: 'Germany', timezone: 'Europe/Berlin', currency: 'EUR', flag: '🇩🇪' },
      { code: 'AT', name: 'Austria', timezone: 'Europe/Vienna', currency: 'EUR', flag: '🇦🇹' },
      { code: 'CH', name: 'Switzerland', timezone: 'Europe/Zurich', currency: 'CHF', flag: '🇨🇭' },
      { code: 'NL', name: 'Netherlands', timezone: 'Europe/Amsterdam', currency: 'EUR', flag: '🇳🇱' },
      { code: 'BE', name: 'Belgium', timezone: 'Europe/Brussels', currency: 'EUR', flag: '🇧🇪' },
      { code: 'FR', name: 'France', timezone: 'Europe/Paris', currency: 'EUR', flag: '🇫🇷' },
      { code: 'LU', name: 'Luxembourg', timezone: 'Europe/Luxembourg', currency: 'EUR', flag: '🇱🇺' },
      { code: 'GB', name: 'United Kingdom', timezone: 'Europe/London', currency: 'GBP', flag: '🇬🇧' },
      { code: 'IE', name: 'Ireland', timezone: 'Europe/Dublin', currency: 'EUR', flag: '🇮🇪' },
      { code: 'ES', name: 'Spain', timezone: 'Europe/Madrid', currency: 'EUR', flag: '🇪🇸' },
      { code: 'IT', name: 'Italy', timezone: 'Europe/Rome', currency: 'EUR', flag: '🇮🇹' },
      { code: 'PT', name: 'Portugal', timezone: 'Europe/Lisbon', currency: 'EUR', flag: '🇵🇹' },
      { code: 'GR', name: 'Greece', timezone: 'Europe/Athens', currency: 'EUR', flag: '🇬🇷' },
      { code: 'PL', name: 'Poland', timezone: 'Europe/Warsaw', currency: 'PLN', flag: '🇵🇱' },
      { code: 'CZ', name: 'Czech Republic', timezone: 'Europe/Prague', currency: 'CZK', flag: '🇨🇿' },
      { code: 'HU', name: 'Hungary', timezone: 'Europe/Budapest', currency: 'HUF', flag: '🇭🇺' },
      { code: 'RO', name: 'Romania', timezone: 'Europe/Bucharest', currency: 'RON', flag: '🇷🇴' },
      { code: 'EE', name: 'Estonia', timezone: 'Europe/Tallinn', currency: 'EUR', flag: '🇪🇪' },
      { code: 'LV', name: 'Latvia', timezone: 'Europe/Riga', currency: 'EUR', flag: '🇱🇻' },
      { code: 'LT', name: 'Lithuania', timezone: 'Europe/Vilnius', currency: 'EUR', flag: '🇱🇹' }
    ];
  }

  getCountrySettings(countryCode) {
    const countries = this.getSupportedCountries();
    
    if (!countryCode || countryCode === '' || countryCode === null || countryCode === undefined) {
      console.log('⚠️  No country code provided, using default (Germany)');
      return countries.find(c => c.code === 'DE');
    }
    
    const upperCode = countryCode.toUpperCase();
    const country = countries.find(c => c.code === countryCode || c.code === upperCode);
    
    if (country) {
      console.log(`🌍 Country: ${country.flag} ${country.name}`);
      return country;
    }
    
    console.warn(`⚠️  Country code "${countryCode}" not found, using Germany`);
    return countries.find(c => c.code === 'DE');
  }

  async makeGraphQLRequest(query, variables = {}) {
    try {
      const response = await axios.post(
        this.apiUrl,
        { query, variables },
        {
          headers: {
            'Authorization': `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );

      if (response.data.errors) {
        throw new Error(response.data.errors[0].message);
      }

      return response.data.data;
    } catch (error) {
      console.error('GraphQL request failed:', error.message);
      throw error;
    }
  }

  async testConnection() {
    try {
      const query = `query { viewer { name } }`;
      const data = await this.makeGraphQLRequest(query);
      console.log(`✅ Connection successful! User: ${data.viewer.name}`);
      return { success: true, user: data.viewer };
    } catch (error) {
      console.error(`❌ Connection test failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async getCurrentPriceInfo(homeId = null) {
    const targetHomeId = homeId || this.config.homeId;
    
    // If no homeId specified, use viewer's first home
    if (!targetHomeId) {
      console.log('📊 No homeId specified, fetching from first available home...');
      return await this.getPriceInfoFromFirstHome();
    }

    console.log(`📊 Fetching price info for home: ${targetHomeId}`);

    const query = `
      query GetPriceInfo($homeId: ID!) {
        viewer {
          home(id: $homeId) {
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
          }
        }
      }
    `;

    try {
      const data = await this.makeGraphQLRequest(query, { homeId: targetHomeId });
      const priceInfo = data.viewer.home.currentSubscription.priceInfo;
      
      // Convert prices from Euro to cents and update currency
      const convertedCurrent = {
        ...priceInfo.current,
        total: priceInfo.current.total * 100,
        energy: priceInfo.current.energy * 100,
        tax: priceInfo.current.tax * 100,
        currency: 'cent'
      };
      
      const convertedToday = priceInfo.today.map(price => ({
        ...price,
        total: price.total * 100,
        energy: price.energy * 100,
        tax: price.tax * 100,
        currency: 'cent'
      }));
      
      const convertedTomorrow = (priceInfo.tomorrow || []).map(price => ({
        ...price,
        total: price.total * 100,
        energy: price.energy * 100,
        tax: price.tax * 100,
        currency: 'cent'
      }));
      
      this.cache.currentPrice = convertedCurrent;
      this.cache.priceInfo = {
        ...priceInfo,
        current: convertedCurrent,
        today: convertedToday,
        tomorrow: convertedTomorrow
      };
      this.cache.forecast = [...convertedToday, ...convertedTomorrow];
      this.lastUpdate = new Date();
      await this.saveCache();
      
      console.log(`✅ Price: ${convertedCurrent.total.toFixed(2)} cent (${convertedCurrent.level})`);
      
      return this.cache.priceInfo;
    } catch (error) {
      console.error('❌ Error fetching price info:', error.message);
      throw error;
    }
  }

  async getPriceInfoFromFirstHome() {
    console.log('📊 Fetching price info from first available home (no homeId required)...');

    const query = `
      query GetFirstHomePriceInfo {
        viewer {
          homes {
            id
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
          }
        }
      }
    `;

    try {
      const data = await this.makeGraphQLRequest(query);
      
      if (!data.viewer.homes || data.viewer.homes.length === 0) {
        throw new Error('No homes found in your Tibber account');
      }

      const firstHome = data.viewer.homes[0];
      console.log(`✅ Using first available home: ${firstHome.id}`);
      
      const priceInfo = firstHome.currentSubscription.priceInfo;
      
      // Convert prices from Euro to cents and update currency
      const convertedCurrent = {
        ...priceInfo.current,
        total: priceInfo.current.total * 100,
        energy: priceInfo.current.energy * 100,
        tax: priceInfo.current.tax * 100,
        currency: 'cent'
      };
      
      const convertedToday = priceInfo.today.map(price => ({
        ...price,
        total: price.total * 100,
        energy: price.energy * 100,
        tax: price.tax * 100,
        currency: 'cent'
      }));
      
      const convertedTomorrow = (priceInfo.tomorrow || []).map(price => ({
        ...price,
        total: price.total * 100,
        energy: price.energy * 100,
        tax: price.tax * 100,
        currency: 'cent'
      }));
      
      this.cache.currentPrice = convertedCurrent;
      this.cache.priceInfo = {
        ...priceInfo,
        current: convertedCurrent,
        today: convertedToday,
        tomorrow: convertedTomorrow
      };
      this.cache.forecast = [...convertedToday, ...convertedTomorrow];
      this.lastUpdate = new Date();
      await this.saveCache();
      
      console.log(`✅ Price: ${convertedCurrent.total.toFixed(2)} cent (${convertedCurrent.level})`);
      
      return this.cache.priceInfo;
    } catch (error) {
      console.error('❌ Error fetching price info from first home:', error.message);
      throw error;
    }
  }

  async refreshData() {
    try {
      if (!this.config.enabled) {
        console.log('ℹ️  Tibber disabled');
        return false;
      }

      if (!this.config.apiKey || this.config.apiKey === '***' || this.config.apiKey === '') {
        console.log('⚠️  No valid API key');
        return false;
      }

      // homeId is now optional - will use first available home if not set
      console.log('🔄 Refreshing Tibber data...');
      await this.getCurrentPriceInfo();
      console.log('✅ Data refreshed');
      return true;
    } catch (error) {
      console.error('❌ Refresh error:', error.message);
      return false;
    }
  }

  getCachedData() {
    return {
      ...this.cache,
      config: {
        enabled: this.config.enabled,
        currency: this.config.currency,
        timezone: this.config.timezone,
        targetSoC: this.config.targetSoC,
        minimumSoC: this.config.minimumSoC
      },
      lastUpdate: this.lastUpdate
    };
  }

  calculateAveragePrice(hours = 24) {
    if (!this.cache.forecast || this.cache.forecast.length === 0) {
      return null;
    }

    const now = new Date();
    const futureHours = this.cache.forecast
      .filter(price => new Date(price.startsAt) > now)
      .slice(0, hours);

    if (futureHours.length === 0) return null;

    const avg = futureHours.reduce((acc, p) => acc + p.total, 0) / futureHours.length;
    return avg;
  }

  getCheapestHours(count = 6, hoursAhead = 24) {
    if (!this.cache.forecast || this.cache.forecast.length === 0) {
      return [];
    }

    const now = new Date();
    const futureHours = this.cache.forecast
      .filter(price => new Date(price.startsAt) > now)
      .slice(0, hoursAhead);

    return futureHours
      .sort((a, b) => a.total - b.total)
      .slice(0, count)
      .map(price => ({
        time: price.startsAt,
        price: price.total,
        level: price.level
      }));
  }

  isPriceGood(currentPrice = null) {
    const price = currentPrice || this.cache.currentPrice;
    if (!price) return false;

    if (this.config.usePriceLevels) {
      return this.config.allowedPriceLevels.includes(price.level);
    }

    const avgPrice = this.calculateAveragePrice();
    if (avgPrice !== null) {
      return price.total < avgPrice;
    }

    if (this.config.maxPriceThreshold !== null) {
      return price.total <= this.config.maxPriceThreshold;
    }

    return false;
  }

  getStatus() {
    return {
      enabled: this.config.enabled,
      configured: !!(this.config.apiKey && this.config.apiKey !== '***'),
      lastUpdate: this.lastUpdate ? this.lastUpdate.toISOString() : null,
      hasCachedData: !!(this.cache.currentPrice && this.cache.forecast.length > 0),
      currentPrice: this.cache.currentPrice ? {
        total: this.cache.currentPrice.total,
        level: this.cache.currentPrice.level,
        currency: this.cache.currentPrice.currency
      } : null,
      priceIsGood: this.cache.currentPrice ? this.isPriceGood() : false,
      forecastHours: this.cache.forecast.length,
      cacheAge: this.cache.timestamp ? Math.floor((Date.now() - this.cache.timestamp) / 1000) : null
    };
  }

  async diagnose() {
    console.log('\n🔍 === TIBBER DIAGNOSTIC ===');
    
    const keyLength = this.config.apiKey ? this.config.apiKey.length : 0;
    const keyStatus = keyLength === 0 ? '❌ Missing' : 
                     keyLength < 30 ? '⚠️  May be too short' : '✅ Valid length';
    
    console.log('Config:', {
      enabled: this.config.enabled,
      apiKey: keyStatus + ` (${keyLength} chars)`,
      homeId: this.config.homeId || 'none (optional - will use first home)',
      country: this.config.country,
      timezone: this.config.timezone,
      currency: this.config.currency
    });
    
    console.log('\nℹ️  Note: API key saved exactly as entered (no validation).');
    console.log('ℹ️  Home ID is optional - will automatically use first available home if not set.');
    
    console.log('===========================\n');
  }
}

module.exports = new TibberService();