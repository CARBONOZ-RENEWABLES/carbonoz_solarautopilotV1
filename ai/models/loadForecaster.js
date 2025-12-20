// Load Forecasting Model - Pattern-based household consumption prediction

class LoadForecaster {
  constructor() {
    this.models = {
      hourly: new Map(),     // hour -> {weekday: avg, weekend: avg}
      daily: new Map(),      // day_of_week -> hourly_profile
      seasonal: new Map(),   // month -> adjustment_factor
      special: new Map()     // special_days -> pattern
    };
    
    this.trained = false;
    this.accuracy = 0;
    this.recentData = [];
    this.baselineLoad = 500; // Default baseline in watts
  }

  async train(historicalLoadData) {
    console.log('⚡ Training load forecaster with consumption patterns...');
    
    if (historicalLoadData.length < 30) {
      console.log('⚠️  Insufficient load data for training');
      return false;
    }

    this.buildHourlyModel(historicalLoadData);
    this.buildDailyModel(historicalLoadData);
    this.buildSeasonalModel(historicalLoadData);
    this.detectSpecialPatterns(historicalLoadData);
    
    this.trained = true;
    console.log(`✅ Load forecaster trained with ${historicalLoadData.length} data points`);
    return true;
  }

  buildHourlyModel(data) {
    // Build hour-of-day model with weekday/weekend distinction
    const hourlyData = new Map();
    
    data.forEach(point => {
      const date = new Date(point.timestamp);
      const hour = date.getHours();
      const isWeekend = date.getDay() === 0 || date.getDay() === 6;
      
      if (!hourlyData.has(hour)) {
        hourlyData.set(hour, { weekday: [], weekend: [] });
      }
      
      const dayType = isWeekend ? 'weekend' : 'weekday';
      hourlyData.get(hour)[dayType].push(point.power || 0);
    });

    // Calculate averages and patterns
    hourlyData.forEach((data, hour) => {
      const weekdayAvg = data.weekday.length > 0 ? 
        data.weekday.reduce((a, b) => a + b, 0) / data.weekday.length : this.baselineLoad;
      const weekendAvg = data.weekend.length > 0 ? 
        data.weekend.reduce((a, b) => a + b, 0) / data.weekend.length : this.baselineLoad;
      
      this.models.hourly.set(hour, {
        weekday: weekdayAvg,
        weekend: weekendAvg,
        variance: this.calculateVariance([...data.weekday, ...data.weekend])
      });
    });
  }

  buildDailyModel(data) {
    // Build day-of-week profiles
    const dailyData = new Map();
    
    // Initialize for each day of week (0=Sunday, 6=Saturday)
    for (let day = 0; day < 7; day++) {
      dailyData.set(day, new Array(24).fill([]));
    }
    
    data.forEach(point => {
      const date = new Date(point.timestamp);
      const dayOfWeek = date.getDay();
      const hour = date.getHours();
      
      if (!dailyData.get(dayOfWeek)[hour]) {
        dailyData.get(dayOfWeek)[hour] = [];
      }
      dailyData.get(dayOfWeek)[hour].push(point.power || 0);
    });

    // Calculate daily profiles
    dailyData.forEach((hourlyArrays, dayOfWeek) => {
      const profile = hourlyArrays.map(hourData => {
        if (hourData.length === 0) return this.baselineLoad;
        return hourData.reduce((a, b) => a + b, 0) / hourData.length;
      });
      
      this.models.daily.set(dayOfWeek, profile);
    });
  }

  buildSeasonalModel(data) {
    // Build seasonal adjustment factors
    const monthlyData = new Map();
    
    data.forEach(point => {
      const month = new Date(point.timestamp).getMonth();
      if (!monthlyData.has(month)) {
        monthlyData.set(month, []);
      }
      monthlyData.get(month).push(point.power || 0);
    });

    // Calculate monthly averages and adjustment factors
    const yearlyAvg = data.reduce((sum, point) => sum + (point.power || 0), 0) / data.length;
    
    monthlyData.forEach((monthData, month) => {
      const monthlyAvg = monthData.reduce((a, b) => a + b, 0) / monthData.length;
      const adjustmentFactor = monthlyAvg / yearlyAvg;
      
      this.models.seasonal.set(month, {
        factor: adjustmentFactor,
        avg: monthlyAvg,
        samples: monthData.length
      });
    });
  }

  detectSpecialPatterns(data) {
    // Detect holidays, anomalies, and special consumption patterns
    const dailyTotals = this.groupByDays(data);
    
    // Find days with unusual consumption (holidays, special events)
    const avgDailyConsumption = dailyTotals.reduce((sum, day) => sum + day.total, 0) / dailyTotals.length;
    const threshold = avgDailyConsumption * 0.7; // 30% below average
    
    dailyTotals.forEach(day => {
      if (day.total < threshold) {
        const dayType = this.classifySpecialDay(day.date);
        if (!this.models.special.has(dayType)) {
          this.models.special.set(dayType, []);
        }
        this.models.special.get(dayType).push(day.profile);
      }
    });

    // Calculate average profiles for special days
    this.models.special.forEach((profiles, dayType) => {
      const avgProfile = new Array(24).fill(0);
      profiles.forEach(profile => {
        profile.forEach((value, hour) => {
          avgProfile[hour] += value;
        });
      });
      
      avgProfile.forEach((sum, hour) => {
        avgProfile[hour] = sum / profiles.length;
      });
      
      this.models.special.set(dayType, avgProfile);
    });
  }

  groupByDays(data) {
    const days = new Map();
    
    data.forEach(point => {
      const date = new Date(point.timestamp);
      const dayKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      
      if (!days.has(dayKey)) {
        days.set(dayKey, { 
          date, 
          profile: new Array(24).fill(0), 
          counts: new Array(24).fill(0),
          total: 0 
        });
      }
      
      const hour = date.getHours();
      const day = days.get(dayKey);
      day.profile[hour] += point.power || 0;
      day.counts[hour]++;
      day.total += point.power || 0;
    });
    
    // Calculate averages
    return Array.from(days.values()).map(day => {
      day.profile = day.profile.map((sum, hour) => 
        day.counts[hour] > 0 ? sum / day.counts[hour] : 0
      );
      return day;
    });
  }

  classifySpecialDay(date) {
    const month = date.getMonth();
    const day = date.getDate();
    
    // Common holidays (simplified)
    if ((month === 11 && day === 25) || (month === 0 && day === 1)) return 'major_holiday';
    if (month === 11 && day >= 24 && day <= 26) return 'christmas_period';
    if (month === 0 && day <= 2) return 'new_year_period';
    
    return 'low_consumption_day';
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
        power: Math.max(50, prediction.power), // Minimum 50W baseline
        confidence: prediction.confidence,
        factors: prediction.factors
      });
    }
    
    return predictions;
  }

  predictHour(targetTime) {
    const hour = targetTime.getHours();
    const dayOfWeek = targetTime.getDay();
    const month = targetTime.getMonth();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    
    // Base prediction from hourly model
    let basePrediction = this.baselineLoad;
    if (this.models.hourly.has(hour)) {
      const hourlyModel = this.models.hourly.get(hour);
      basePrediction = isWeekend ? hourlyModel.weekend : hourlyModel.weekday;
    }
    
    // Daily pattern adjustment
    let dailyAdjustment = 1.0;
    if (this.models.daily.has(dayOfWeek)) {
      const dailyProfile = this.models.daily.get(dayOfWeek);
      const dailyAvg = dailyProfile.reduce((a, b) => a + b, 0) / 24;
      if (dailyAvg > 0) {
        dailyAdjustment = dailyProfile[hour] / dailyAvg;
      }
    }
    
    // Seasonal adjustment
    let seasonalFactor = 1.0;
    if (this.models.seasonal.has(month)) {
      seasonalFactor = this.models.seasonal.get(month).factor;
    }
    
    // Special day check
    const specialDayFactor = this.checkSpecialDay(targetTime);
    
    // Recent trend analysis
    const trendFactor = this.analyzeTrend(targetTime);
    
    // Combine all factors
    const prediction = basePrediction * dailyAdjustment * seasonalFactor * specialDayFactor * trendFactor;
    
    const confidence = this.calculateConfidence(hour, dayOfWeek, month);
    
    return {
      power: prediction,
      confidence,
      factors: {
        base: basePrediction,
        daily: dailyAdjustment,
        seasonal: seasonalFactor,
        special: specialDayFactor,
        trend: trendFactor
      }
    };
  }

  checkSpecialDay(date) {
    const dayType = this.classifySpecialDay(date);
    
    if (this.models.special.has(dayType)) {
      return 0.7; // Reduced consumption on special days
    }
    
    return 1.0; // Normal day
  }

  analyzeTrend(targetTime) {
    // Analyze recent consumption trend
    if (this.recentData.length < 7) return 1.0;
    
    const recentWeek = this.recentData.slice(-168); // Last 7 days
    const avgRecent = recentWeek.reduce((sum, point) => sum + point.power, 0) / recentWeek.length;
    
    const hour = targetTime.getHours();
    const isWeekend = targetTime.getDay() === 0 || targetTime.getDay() === 6;
    
    let expectedAvg = this.baselineLoad;
    if (this.models.hourly.has(hour)) {
      const hourlyModel = this.models.hourly.get(hour);
      expectedAvg = isWeekend ? hourlyModel.weekend : hourlyModel.weekday;
    }
    
    return Math.max(0.5, Math.min(1.5, avgRecent / expectedAvg));
  }

  calculateConfidence(hour, dayOfWeek, month) {
    let confidence = 0.6; // Base confidence
    
    // Higher confidence for hours with more data
    if (this.models.hourly.has(hour)) {
      confidence += 0.2;
    }
    
    // Higher confidence for known day patterns
    if (this.models.daily.has(dayOfWeek)) {
      confidence += 0.1;
    }
    
    // Higher confidence for seasonal data
    if (this.models.seasonal.has(month)) {
      confidence += 0.1;
    }
    
    return Math.min(0.9, confidence);
  }

  fallbackPrediction(startTime, hoursAhead) {
    // Simple fallback when no training data available
    const predictions = [];
    
    for (let h = 0; h < hoursAhead; h++) {
      const targetTime = new Date(startTime.getTime() + h * 60 * 60 * 1000);
      const hour = targetTime.getHours();
      const isWeekend = targetTime.getDay() === 0 || targetTime.getDay() === 6;
      
      // Simple consumption pattern
      let power = this.baselineLoad;
      
      // Morning peak
      if (hour >= 6 && hour <= 8) power *= 1.5;
      // Evening peak
      else if (hour >= 18 && hour <= 21) power *= 1.8;
      // Night reduction
      else if (hour >= 23 || hour <= 5) power *= 0.6;
      
      // Weekend adjustment
      if (isWeekend) {
        if (hour >= 9 && hour <= 11) power *= 1.3; // Late morning
        if (hour >= 6 && hour <= 8) power *= 0.8;  // Reduced morning peak
      }
      
      predictions.push({
        timestamp: targetTime,
        power,
        confidence: 0.4, // Low confidence without training
        factors: { fallback: true }
      });
    }
    
    return predictions;
  }

  async updateModel(newDataPoint) {
    // Add new data for continuous learning
    this.recentData.push({
      timestamp: newDataPoint.timestamp,
      power: newDataPoint.load,
      hour: new Date(newDataPoint.timestamp).getHours(),
      dayOfWeek: new Date(newDataPoint.timestamp).getDay()
    });
    
    // Keep only recent 30 days
    if (this.recentData.length > 720) { // 30 days * 24 hours
      this.recentData = this.recentData.slice(-720);
    }
  }

  calculateVariance(values) {
    if (values.length === 0) return 0;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((acc, v) => acc + Math.pow(v - avg, 2), 0) / values.length;
  }

  getStatus() {
    return {
      trained: this.trained,
      accuracy: this.accuracy,
      dataPoints: this.recentData.length,
      patterns: {
        hourly: this.models.hourly.size,
        daily: this.models.daily.size,
        seasonal: this.models.seasonal.size,
        special: this.models.special.size
      },
      baselineLoad: this.baselineLoad
    };
  }
}

module.exports = LoadForecaster;