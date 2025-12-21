// Solar Generation Predictor - Pattern-based learning without weather APIs
// Uses astronomical calculations + historical patterns

class SolarPredictor {
  constructor() {
    this.models = {
      seasonal: new Map(), // month -> typical production curve
      hourly: new Map(),   // hour -> average production
      patterns: new Map()  // pattern_id -> production profile
    };
    
    this.location = { lat: 52.5, lon: 13.4 }; // Default Berlin, configurable
    this.trained = false;
    this.accuracy = 0;
    this.recentData = [];
    this.maxRecentData = 168; // Limit to 7 days (168 hours) to save memory
  }

  async train(historicalSolarData) {
    console.log('🌞 Training solar predictor with historical patterns...');
    
    if (historicalSolarData.length < 30) {
      console.log('⚠️  Insufficient solar data for training');
      return false;
    }

    // Group data by patterns
    this.buildSeasonalModel(historicalSolarData);
    this.buildHourlyModel(historicalSolarData);
    this.detectDayPatterns(historicalSolarData);
    
    this.trained = true;
    console.log(`✅ Solar predictor trained with ${historicalSolarData.length} data points`);
    return true;
  }

  buildSeasonalModel(data) {
    // Group by month and calculate typical production curves
    const monthlyData = new Map();
    
    data.forEach(point => {
      const month = new Date(point.timestamp).getMonth();
      if (!monthlyData.has(month)) {
        monthlyData.set(month, []);
      }
      monthlyData.get(month).push(point);
    });

    // Calculate seasonal patterns
    monthlyData.forEach((monthData, month) => {
      const hourlyAvg = new Array(24).fill(0);
      const hourlyCounts = new Array(24).fill(0);
      
      monthData.forEach(point => {
        const hour = new Date(point.timestamp).getHours();
        hourlyAvg[hour] += point.power || 0;
        hourlyCounts[hour]++;
      });
      
      // Calculate averages
      for (let h = 0; h < 24; h++) {
        if (hourlyCounts[h] > 0) {
          hourlyAvg[h] /= hourlyCounts[h];
        }
      }
      
      this.models.seasonal.set(month, hourlyAvg);
    });
  }

  buildHourlyModel(data) {
    // Build hour-of-day model across all seasons
    const hourlyData = new Map();
    
    data.forEach(point => {
      const hour = new Date(point.timestamp).getHours();
      if (!hourlyData.has(hour)) {
        hourlyData.set(hour, []);
      }
      hourlyData.get(hour).push(point.power || 0);
    });

    // Calculate hourly averages and variance
    hourlyData.forEach((powers, hour) => {
      const avg = powers.reduce((a, b) => a + b, 0) / powers.length;
      const variance = powers.reduce((acc, p) => acc + Math.pow(p - avg, 2), 0) / powers.length;
      
      this.models.hourly.set(hour, { avg, variance, count: powers.length });
    });
  }

  detectDayPatterns(data) {
    // Detect typical sunny vs cloudy day patterns
    const dailyProfiles = this.groupByDays(data);
    
    // Cluster days into patterns (simple k-means approach)
    const patterns = this.clusterDayPatterns(dailyProfiles);
    
    patterns.forEach((pattern, id) => {
      this.models.patterns.set(id, pattern);
    });
  }

  groupByDays(data) {
    const days = new Map();
    
    data.forEach(point => {
      const date = new Date(point.timestamp);
      const dayKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      
      if (!days.has(dayKey)) {
        days.set(dayKey, { date, hourly: new Array(24).fill(0) });
      }
      
      const hour = date.getHours();
      days.get(dayKey).hourly[hour] = point.power || 0;
    });
    
    return Array.from(days.values());
  }

  clusterDayPatterns(dailyProfiles) {
    // Simple clustering: sunny vs cloudy vs mixed
    const patterns = new Map();
    
    dailyProfiles.forEach(day => {
      const totalProduction = day.hourly.reduce((a, b) => a + b, 0);
      const peakHour = day.hourly.indexOf(Math.max(...day.hourly));
      const variance = this.calculateVariance(day.hourly);
      
      let patternType = 'mixed';
      if (totalProduction > this.getSeasonalAverage(day.date) * 1.2 && variance < 1000) {
        patternType = 'sunny';
      } else if (totalProduction < this.getSeasonalAverage(day.date) * 0.6) {
        patternType = 'cloudy';
      }
      
      if (!patterns.has(patternType)) {
        patterns.set(patternType, { profiles: [], avg: new Array(24).fill(0) });
      }
      
      patterns.get(patternType).profiles.push(day.hourly);
    });
    
    // Calculate average profiles for each pattern
    patterns.forEach((pattern, type) => {
      for (let h = 0; h < 24; h++) {
        const hourValues = pattern.profiles.map(p => p[h]);
        pattern.avg[h] = hourValues.reduce((a, b) => a + b, 0) / hourValues.length;
      }
    });
    
    return patterns;
  }

  async predict(startTime, hoursAhead = 24) {
    if (!this.trained) {
      return this.fallbackPrediction(startTime, hoursAhead);
    }

    const predictions = [];
    
    for (let h = 0; h < hoursAhead; h++) {
      const targetTime = new Date(startTime.getTime() + h * 60 * 60 * 1000);
      const prediction = this.predictHour(targetTime);
      
      predictions.push({
        timestamp: targetTime,
        power: Math.max(0, prediction.power),
        confidence: prediction.confidence,
        factors: prediction.factors
      });
    }
    
    return predictions;
  }

  predictHour(targetTime) {
    const hour = targetTime.getHours();
    const month = targetTime.getMonth();
    const dayOfYear = this.getDayOfYear(targetTime);
    
    // Base prediction from seasonal model
    let basePrediction = 0;
    if (this.models.seasonal.has(month)) {
      basePrediction = this.models.seasonal.get(month)[hour];
    }
    
    // Adjust with hourly model
    let hourlyAdjustment = 0;
    if (this.models.hourly.has(hour)) {
      hourlyAdjustment = this.models.hourly.get(hour).avg;
    }
    
    // Sun position calculation
    const sunPosition = this.calculateSunPosition(targetTime);
    const sunFactor = Math.max(0, Math.sin(sunPosition.elevation * Math.PI / 180));
    
    // Recent trend analysis
    const trendFactor = this.analyzeTrend(targetTime);
    
    // Pattern matching
    const patternFactor = this.matchPattern(targetTime);
    
    // Combine factors
    const prediction = (basePrediction * 0.4 + hourlyAdjustment * 0.3) * sunFactor * trendFactor * patternFactor;
    
    const confidence = this.calculateConfidence(hour, month, sunPosition);
    
    return {
      power: prediction,
      confidence,
      factors: {
        base: basePrediction,
        hourly: hourlyAdjustment,
        sun: sunFactor,
        trend: trendFactor,
        pattern: patternFactor
      }
    };
  }

  calculateSunPosition(date) {
    // Simplified sun position calculation
    const dayOfYear = this.getDayOfYear(date);
    const hour = date.getHours() + date.getMinutes() / 60;
    
    // Solar declination
    const declination = 23.45 * Math.sin((360 * (284 + dayOfYear) / 365) * Math.PI / 180);
    
    // Hour angle
    const hourAngle = 15 * (hour - 12);
    
    // Solar elevation
    const elevation = Math.asin(
      Math.sin(declination * Math.PI / 180) * Math.sin(this.location.lat * Math.PI / 180) +
      Math.cos(declination * Math.PI / 180) * Math.cos(this.location.lat * Math.PI / 180) * Math.cos(hourAngle * Math.PI / 180)
    ) * 180 / Math.PI;
    
    return { elevation: Math.max(0, elevation), declination, hourAngle };
  }

  analyzeTrend(targetTime) {
    // Analyze recent 3-7 days trend
    if (this.recentData.length < 3) return 1.0;
    
    const recentDays = this.recentData.slice(-7);
    const avgRecent = recentDays.reduce((sum, day) => sum + day.total, 0) / recentDays.length;
    const seasonalExpected = this.getSeasonalAverage(targetTime);
    
    return Math.max(0.3, Math.min(1.7, avgRecent / seasonalExpected));
  }

  matchPattern(targetTime) {
    // Match current conditions to known patterns
    const recentVariance = this.getRecentVariance();
    
    if (recentVariance < 500) {
      // Stable conditions - likely sunny
      return this.models.patterns.has('sunny') ? 1.2 : 1.0;
    } else if (recentVariance > 2000) {
      // High variance - likely cloudy/mixed
      return this.models.patterns.has('cloudy') ? 0.6 : 0.8;
    }
    
    return 1.0; // Mixed conditions
  }

  getRecentVariance() {
    if (this.recentData.length < 2) return 1000;
    
    const recent = this.recentData.slice(-3);
    const values = recent.map(d => d.total);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    
    return values.reduce((acc, v) => acc + Math.pow(v - avg, 2), 0) / values.length;
  }

  getSeasonalAverage(date) {
    const month = date.getMonth();
    if (!this.models.seasonal.has(month)) return 1000; // Default
    
    return this.models.seasonal.get(month).reduce((a, b) => a + b, 0);
  }

  calculateConfidence(hour, month, sunPosition) {
    let confidence = 0.5; // Base confidence
    
    // Higher confidence during daylight hours
    if (hour >= 6 && hour <= 18 && sunPosition.elevation > 0) {
      confidence += 0.3;
    }
    
    // Higher confidence if we have seasonal data
    if (this.models.seasonal.has(month)) {
      confidence += 0.2;
    }
    
    // Higher confidence if we have hourly data
    if (this.models.hourly.has(hour)) {
      confidence += 0.1;
    }
    
    return Math.min(0.95, confidence);
  }

  fallbackPrediction(startTime, hoursAhead) {
    // Simple fallback when no training data available
    const predictions = [];
    
    for (let h = 0; h < hoursAhead; h++) {
      const targetTime = new Date(startTime.getTime() + h * 60 * 60 * 1000);
      const hour = targetTime.getHours();
      const sunPosition = this.calculateSunPosition(targetTime);
      
      // Simple bell curve for solar production
      let power = 0;
      if (hour >= 6 && hour <= 18) {
        const sunFactor = Math.max(0, Math.sin(sunPosition.elevation * Math.PI / 180));
        power = 3000 * sunFactor; // Assume 3kW peak system
      }
      
      predictions.push({
        timestamp: targetTime,
        power,
        confidence: 0.3, // Low confidence without training
        factors: { fallback: true }
      });
    }
    
    return predictions;
  }

  async updateModel(newDataPoint) {
    // Add new data for continuous learning
    this.recentData.push({
      timestamp: newDataPoint.timestamp,
      total: newDataPoint.solar,
      hour: new Date(newDataPoint.timestamp).getHours()
    });
    
    // Keep only recent data to prevent memory leaks
    if (this.recentData.length > this.maxRecentData) {
      this.recentData = this.recentData.slice(-this.maxRecentData);
    }
  }

  getDayOfYear(date) {
    const start = new Date(date.getFullYear(), 0, 0);
    const diff = date - start;
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  }

  calculateVariance(values) {
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((acc, v) => acc + Math.pow(v - avg, 2), 0) / values.length;
  }

  setLocation(lat, lon) {
    this.location = { lat, lon };
    console.log(`📍 Solar predictor location set to: ${lat}, ${lon}`);
  }

  getStatus() {
    return {
      trained: this.trained,
      accuracy: this.accuracy,
      dataPoints: this.recentData.length,
      patterns: this.models.patterns.size,
      location: this.location
    };
  }
}

module.exports = SolarPredictor;