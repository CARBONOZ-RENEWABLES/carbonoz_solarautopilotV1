// Data Processor - Loads and prepares historical data for AI training

class DataProcessor {
  constructor() {
    this.dataCache = new Map();
    this.lastCacheUpdate = null;
  }

  async loadHistoricalData(influxClient, daysBack = 365) {
    console.log(`📊 Loading ${daysBack} days of historical data...`);
    
    try {
      // Check cache first
      const cacheKey = `historical_${daysBack}`;
      if (this.dataCache.has(cacheKey) && this.isCacheValid(cacheKey)) {
        console.log('✅ Using cached historical data');
        return this.dataCache.get(cacheKey);
      }

      const endTime = new Date();
      const startTime = new Date(endTime.getTime() - (daysBack * 24 * 60 * 60 * 1000));
      
      // Load solar data
      const solarData = await this.loadSolarData(influxClient, startTime, endTime);
      console.log(`📈 Loaded ${solarData.length} solar data points`);
      
      // Load load data
      const loadData = await this.loadLoadData(influxClient, startTime, endTime);
      console.log(`⚡ Loaded ${loadData.length} load data points`);
      
      // Load price data
      const priceData = await this.loadPriceData(influxClient, startTime, endTime);
      console.log(`💰 Loaded ${priceData.length} price data points`);
      
      // Load battery data
      const batteryData = await this.loadBatteryData(influxClient, startTime, endTime);
      console.log(`🔋 Loaded ${batteryData.length} battery data points`);
      
      // Process and align data
      const processedData = this.processAndAlignData({
        solar: solarData,
        load: loadData,
        prices: priceData,
        battery: batteryData
      });
      
      // Cache the result
      this.dataCache.set(cacheKey, processedData);
      this.lastCacheUpdate = new Date();
      
      console.log('✅ Historical data loaded and processed');
      return processedData;
      
    } catch (error) {
      console.error('❌ Error loading historical data:', error);
      return this.getEmptyDataset();
    }
  }

  async loadSolarData(influxClient, startTime, endTime) {
    try {
      const query = `
        SELECT mean("value") as power, time
        FROM "state"
        WHERE "topic" =~ /.*pv_power.*state$/
        AND time >= '${startTime.toISOString()}'
        AND time <= '${endTime.toISOString()}'
        GROUP BY time(1h)
        ORDER BY time ASC
      `;
      
      const result = await influxClient.query(query);
      
      return result.map(row => ({
        timestamp: new Date(row.time),
        power: Math.max(0, row.power || 0), // Ensure non-negative
        type: 'solar'
      }));
      
    } catch (error) {
      console.warn('⚠️  Could not load solar data:', error.message);
      return [];
    }
  }

  async loadLoadData(influxClient, startTime, endTime) {
    try {
      const query = `
        SELECT mean("value") as power, time
        FROM "state"
        WHERE "topic" =~ /.*load.*state$/
        AND time >= '${startTime.toISOString()}'
        AND time <= '${endTime.toISOString()}'
        GROUP BY time(1h)
        ORDER BY time ASC
      `;
      
      const result = await influxClient.query(query);
      
      return result.map(row => ({
        timestamp: new Date(row.time),
        power: Math.max(0, row.power || 0), // Ensure non-negative
        type: 'load'
      }));
      
    } catch (error) {
      console.warn('⚠️  Could not load load data:', error.message);
      return [];
    }
  }

  async loadPriceData(influxClient, startTime, endTime) {
    try {
      const query = `
        SELECT mean("total") as price, mean("energy") as energy, last("level") as level, time
        FROM "tibber_prices"
        WHERE time >= '${startTime.toISOString()}'
        AND time <= '${endTime.toISOString()}'
        GROUP BY time(1h)
        ORDER BY time ASC
      `;
      
      const result = await influxClient.query(query);
      
      return result.map(row => ({
        timestamp: new Date(row.time),
        price: (row.price || 0) * 100, // Convert to cents
        energy: (row.energy || 0) * 100,
        level: row.level || 'NORMAL',
        type: 'price'
      }));
      
    } catch (error) {
      console.warn('⚠️  Could not load price data:', error.message);
      return [];
    }
  }

  async loadBatteryData(influxClient, startTime, endTime) {
    try {
      const query = `
        SELECT mean("value") as soc, time
        FROM "state"
        WHERE "topic" =~ /.*battery.*soc.*state$/
        AND time >= '${startTime.toISOString()}'
        AND time <= '${endTime.toISOString()}'
        GROUP BY time(1h)
        ORDER BY time ASC
      `;
      
      const result = await influxClient.query(query);
      
      return result.map(row => ({
        timestamp: new Date(row.time),
        soc: Math.max(0, Math.min(100, row.soc || 0)), // Clamp to 0-100%
        type: 'battery'
      }));
      
    } catch (error) {
      console.warn('⚠️  Could not load battery data:', error.message);
      return [];
    }
  }

  processAndAlignData(rawData) {
    console.log('🔄 Processing and aligning data...');
    
    // Create time-aligned dataset
    const alignedData = this.createTimeAlignedDataset(rawData);
    
    // Fill gaps and smooth data
    const cleanedData = this.cleanAndFillGaps(alignedData);
    
    // Extract features for ML
    const featuredData = this.extractFeatures(cleanedData);
    
    // Calculate statistics
    const statistics = this.calculateStatistics(featuredData);
    
    return {
      solar: featuredData.solar,
      load: featuredData.load,
      prices: featuredData.prices,
      battery: featuredData.battery,
      aligned: featuredData.aligned,
      statistics,
      timeRange: {
        start: featuredData.aligned.length > 0 ? featuredData.aligned[0].timestamp : null,
        end: featuredData.aligned.length > 0 ? featuredData.aligned[featuredData.aligned.length - 1].timestamp : null,
        hours: featuredData.aligned.length
      }
    };
  }

  createTimeAlignedDataset(rawData) {
    // Find the common time range
    const allTimestamps = [
      ...rawData.solar.map(d => d.timestamp.getTime()),
      ...rawData.load.map(d => d.timestamp.getTime()),
      ...rawData.prices.map(d => d.timestamp.getTime()),
      ...rawData.battery.map(d => d.timestamp.getTime())
    ];
    
    if (allTimestamps.length === 0) {
      return { solar: [], load: [], prices: [], battery: [], aligned: [] };
    }
    
    const startTime = new Date(Math.min(...allTimestamps));
    const endTime = new Date(Math.max(...allTimestamps));
    
    // Create hourly time slots
    const timeSlots = [];
    for (let time = new Date(startTime); time <= endTime; time.setHours(time.getHours() + 1)) {
      timeSlots.push(new Date(time));
    }
    
    // Align data to time slots
    const aligned = timeSlots.map(timestamp => {
      const slot = {
        timestamp,
        solar: this.findClosestValue(rawData.solar, timestamp, 'power'),
        load: this.findClosestValue(rawData.load, timestamp, 'power'),
        price: this.findClosestValue(rawData.prices, timestamp, 'price'),
        priceLevel: this.findClosestValue(rawData.prices, timestamp, 'level'),
        batterySoc: this.findClosestValue(rawData.battery, timestamp, 'soc')
      };
      
      return slot;
    });
    
    return {
      solar: rawData.solar,
      load: rawData.load,
      prices: rawData.prices,
      battery: rawData.battery,
      aligned
    };
  }

  findClosestValue(dataArray, targetTime, valueField) {
    if (dataArray.length === 0) return null;
    
    let closest = dataArray[0];
    let minDiff = Math.abs(dataArray[0].timestamp.getTime() - targetTime.getTime());
    
    for (const item of dataArray) {
      const diff = Math.abs(item.timestamp.getTime() - targetTime.getTime());
      if (diff < minDiff) {
        minDiff = diff;
        closest = item;
      }
    }
    
    // Only return value if within 2 hours
    if (minDiff <= 2 * 60 * 60 * 1000) {
      return closest[valueField];
    }
    
    return null;
  }

  cleanAndFillGaps(alignedData) {
    console.log('🧹 Cleaning data and filling gaps...');
    
    const cleaned = { ...alignedData };
    
    // Fill gaps in aligned data
    cleaned.aligned = this.fillGapsInAlignedData(alignedData.aligned);
    
    // Remove outliers
    cleaned.aligned = this.removeOutliers(cleaned.aligned);
    
    // Smooth data
    cleaned.aligned = this.smoothData(cleaned.aligned);
    
    return cleaned;
  }

  fillGapsInAlignedData(alignedData) {
    if (alignedData.length === 0) return [];
    
    const filled = [...alignedData];
    
    // Forward fill and backward fill for missing values
    for (let i = 0; i < filled.length; i++) {
      const current = filled[i];
      
      // Fill solar gaps
      if (current.solar === null) {
        current.solar = this.interpolateValue(filled, i, 'solar');
      }
      
      // Fill load gaps
      if (current.load === null) {
        current.load = this.interpolateValue(filled, i, 'load');
      }
      
      // Fill price gaps
      if (current.price === null) {
        current.price = this.interpolateValue(filled, i, 'price');
      }
      
      // Fill battery SOC gaps
      if (current.batterySoc === null) {
        current.batterySoc = this.interpolateValue(filled, i, 'batterySoc');
      }
    }
    
    return filled;
  }

  interpolateValue(data, index, field) {
    // Find previous and next valid values
    let prevValue = null;
    let nextValue = null;
    let prevIndex = -1;
    let nextIndex = -1;
    
    // Look backward
    for (let i = index - 1; i >= 0; i--) {
      if (data[i][field] !== null) {
        prevValue = data[i][field];
        prevIndex = i;
        break;
      }
    }
    
    // Look forward
    for (let i = index + 1; i < data.length; i++) {
      if (data[i][field] !== null) {
        nextValue = data[i][field];
        nextIndex = i;
        break;
      }
    }
    
    // Interpolate
    if (prevValue !== null && nextValue !== null) {
      const ratio = (index - prevIndex) / (nextIndex - prevIndex);
      return prevValue + (nextValue - prevValue) * ratio;
    } else if (prevValue !== null) {
      return prevValue; // Forward fill
    } else if (nextValue !== null) {
      return nextValue; // Backward fill
    }
    
    // Default values if no data available
    const defaults = {
      solar: 0,
      load: 500, // 500W baseline
      price: 10, // 10 cents default
      batterySoc: 50 // 50% default
    };
    
    return defaults[field] || 0;
  }

  removeOutliers(alignedData) {
    // Remove statistical outliers (values beyond 3 standard deviations)
    const fields = ['solar', 'load', 'price', 'batterySoc'];
    
    fields.forEach(field => {
      const values = alignedData.map(d => d[field]).filter(v => v !== null);
      if (values.length === 0) return;
      
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / values.length;
      const stdDev = Math.sqrt(variance);
      
      const threshold = 3 * stdDev;
      
      alignedData.forEach(item => {
        if (item[field] !== null && Math.abs(item[field] - mean) > threshold) {
          console.log(`🚫 Removing outlier: ${field} = ${item[field]} at ${item.timestamp}`);
          item[field] = mean; // Replace with mean
        }
      });
    });
    
    return alignedData;
  }

  smoothData(alignedData) {
    // Apply simple moving average smoothing
    const windowSize = 3;
    const smoothed = [...alignedData];
    
    const fields = ['solar', 'load'];
    
    fields.forEach(field => {
      for (let i = windowSize; i < smoothed.length - windowSize; i++) {
        const window = [];
        for (let j = i - windowSize; j <= i + windowSize; j++) {
          if (smoothed[j][field] !== null) {
            window.push(smoothed[j][field]);
          }
        }
        
        if (window.length > 0) {
          smoothed[i][field] = window.reduce((a, b) => a + b, 0) / window.length;
        }
      }
    });
    
    return smoothed;
  }

  extractFeatures(cleanedData) {
    console.log('🔧 Extracting features for ML...');
    
    const featured = { ...cleanedData };
    
    // Add time-based features to aligned data
    featured.aligned = cleanedData.aligned.map(item => ({
      ...item,
      features: this.extractTimeFeatures(item.timestamp)
    }));
    
    return featured;
  }

  extractTimeFeatures(timestamp) {
    const date = new Date(timestamp);
    
    return {
      hour: date.getHours(),
      dayOfWeek: date.getDay(),
      dayOfMonth: date.getDate(),
      month: date.getMonth(),
      dayOfYear: this.getDayOfYear(date),
      isWeekend: date.getDay() === 0 || date.getDay() === 6,
      season: this.getSeason(date.getMonth()),
      hourSin: Math.sin(2 * Math.PI * date.getHours() / 24),
      hourCos: Math.cos(2 * Math.PI * date.getHours() / 24),
      dayOfYearSin: Math.sin(2 * Math.PI * this.getDayOfYear(date) / 365),
      dayOfYearCos: Math.cos(2 * Math.PI * this.getDayOfYear(date) / 365)
    };
  }

  getDayOfYear(date) {
    const start = new Date(date.getFullYear(), 0, 0);
    const diff = date - start;
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  }

  getSeason(month) {
    if (month >= 2 && month <= 4) return 'spring';
    if (month >= 5 && month <= 7) return 'summer';
    if (month >= 8 && month <= 10) return 'autumn';
    return 'winter';
  }

  calculateStatistics(featuredData) {
    console.log('📊 Calculating statistics...');
    
    const stats = {
      solar: this.calculateFieldStatistics(featuredData.aligned, 'solar'),
      load: this.calculateFieldStatistics(featuredData.aligned, 'load'),
      price: this.calculateFieldStatistics(featuredData.aligned, 'price'),
      battery: this.calculateFieldStatistics(featuredData.aligned, 'batterySoc'),
      correlations: this.calculateCorrelations(featuredData.aligned),
      dataQuality: this.assessDataQuality(featuredData)
    };
    
    return stats;
  }

  calculateFieldStatistics(data, field) {
    const values = data.map(d => d[field]).filter(v => v !== null && !isNaN(v));
    
    if (values.length === 0) {
      return { count: 0, mean: 0, min: 0, max: 0, std: 0 };
    }
    
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / values.length;
    const std = Math.sqrt(variance);
    
    return {
      count: values.length,
      mean: mean,
      min: Math.min(...values),
      max: Math.max(...values),
      std: std,
      median: this.calculateMedian(values),
      percentile25: this.calculatePercentile(values, 25),
      percentile75: this.calculatePercentile(values, 75)
    };
  }

  calculateMedian(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  calculatePercentile(values, percentile) {
    const sorted = [...values].sort((a, b) => a - b);
    const index = (percentile / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    
    if (lower === upper) return sorted[lower];
    return sorted[lower] * (upper - index) + sorted[upper] * (index - lower);
  }

  calculateCorrelations(data) {
    const fields = ['solar', 'load', 'price', 'batterySoc'];
    const correlations = {};
    
    for (let i = 0; i < fields.length; i++) {
      for (let j = i + 1; j < fields.length; j++) {
        const field1 = fields[i];
        const field2 = fields[j];
        const correlation = this.pearsonCorrelation(data, field1, field2);
        correlations[`${field1}_${field2}`] = correlation;
      }
    }
    
    return correlations;
  }

  pearsonCorrelation(data, field1, field2) {
    const pairs = data
      .filter(d => d[field1] !== null && d[field2] !== null)
      .map(d => [d[field1], d[field2]]);
    
    if (pairs.length < 2) return 0;
    
    const n = pairs.length;
    const sum1 = pairs.reduce((acc, pair) => acc + pair[0], 0);
    const sum2 = pairs.reduce((acc, pair) => acc + pair[1], 0);
    const sum1Sq = pairs.reduce((acc, pair) => acc + pair[0] * pair[0], 0);
    const sum2Sq = pairs.reduce((acc, pair) => acc + pair[1] * pair[1], 0);
    const pSum = pairs.reduce((acc, pair) => acc + pair[0] * pair[1], 0);
    
    const num = pSum - (sum1 * sum2 / n);
    const den = Math.sqrt((sum1Sq - sum1 * sum1 / n) * (sum2Sq - sum2 * sum2 / n));
    
    return den === 0 ? 0 : num / den;
  }

  assessDataQuality(featuredData) {
    const totalPoints = featuredData.aligned.length;
    if (totalPoints === 0) return { score: 0, issues: ['No data available'] };
    
    const issues = [];
    let score = 100;
    
    // Check data completeness
    const fields = ['solar', 'load', 'price', 'batterySoc'];
    fields.forEach(field => {
      const validPoints = featuredData.aligned.filter(d => d[field] !== null).length;
      const completeness = validPoints / totalPoints;
      
      if (completeness < 0.8) {
        issues.push(`${field} data only ${(completeness * 100).toFixed(1)}% complete`);
        score -= (1 - completeness) * 20;
      }
    });
    
    // Check for sufficient data volume
    if (totalPoints < 168) { // Less than 1 week
      issues.push('Insufficient data volume for reliable training');
      score -= 30;
    }
    
    // Check for data recency
    const latestData = new Date(Math.max(...featuredData.aligned.map(d => d.timestamp.getTime())));
    const daysSinceLatest = (new Date() - latestData) / (1000 * 60 * 60 * 24);
    
    if (daysSinceLatest > 7) {
      issues.push(`Latest data is ${daysSinceLatest.toFixed(0)} days old`);
      score -= Math.min(20, daysSinceLatest);
    }
    
    return {
      score: Math.max(0, score),
      issues,
      totalPoints,
      timeSpan: totalPoints > 0 ? `${(totalPoints / 24).toFixed(1)} days` : '0 days'
    };
  }

  isCacheValid(cacheKey) {
    if (!this.lastCacheUpdate) return false;
    
    const cacheAge = (new Date() - this.lastCacheUpdate) / (1000 * 60 * 60); // Hours
    return cacheAge < 6; // Cache valid for 6 hours
  }

  getEmptyDataset() {
    return {
      solar: [],
      load: [],
      prices: [],
      battery: [],
      aligned: [],
      statistics: {
        solar: { count: 0, mean: 0, min: 0, max: 0, std: 0 },
        load: { count: 0, mean: 0, min: 0, max: 0, std: 0 },
        price: { count: 0, mean: 0, min: 0, max: 0, std: 0 },
        battery: { count: 0, mean: 0, min: 0, max: 0, std: 0 },
        correlations: {},
        dataQuality: { score: 0, issues: ['No data available'], totalPoints: 0 }
      },
      timeRange: { start: null, end: null, hours: 0 }
    };
  }

  clearCache() {
    this.dataCache.clear();
    this.lastCacheUpdate = null;
    console.log('🗑️  Data cache cleared');
  }
}

module.exports = DataProcessor;