// Pattern Detection - Unsupervised learning for energy patterns

class PatternDetector {
  constructor() {
    this.patterns = {
      daily: new Map(),      // Daily energy patterns
      weekly: new Map(),     // Weekly patterns
      seasonal: new Map(),   // Seasonal transitions
      weather: new Map(),    // Weather-like patterns (inferred from solar)
      anomalies: []          // Detected anomalies
    };
    
    this.trained = false;
    this.clusterCount = 5; // Number of pattern clusters
  }

  async analyzePatterns(historicalData) {
    console.log('🔍 Analyzing energy patterns...');
    
    if (!historicalData.solar || historicalData.solar.length < 100) {
      console.log('⚠️  Insufficient data for pattern analysis');
      return false;
    }

    // Detect daily patterns
    await this.detectDailyPatterns(historicalData);
    
    // Detect weekly patterns
    await this.detectWeeklyPatterns(historicalData);
    
    // Detect seasonal transitions
    await this.detectSeasonalPatterns(historicalData);
    
    // Detect weather-like patterns from solar variance
    await this.detectWeatherPatterns(historicalData);
    
    // Detect anomalies
    await this.detectAnomalies(historicalData);
    
    this.trained = true;
    console.log('✅ Pattern analysis complete');
    return true;
  }

  async detectDailyPatterns(historicalData) {
    // Group data by days and cluster similar daily profiles
    const dailyProfiles = this.extractDailyProfiles(historicalData);
    
    // Cluster daily profiles using k-means
    const clusters = this.kMeansClustering(dailyProfiles, this.clusterCount);
    
    // Analyze each cluster
    clusters.forEach((cluster, index) => {
      const pattern = this.analyzeDailyCluster(cluster);
      this.patterns.daily.set(`pattern_${index}`, pattern);
    });
  }

  extractDailyProfiles(historicalData) {
    const dailyProfiles = new Map();
    
    // Group solar and load data by day
    historicalData.solar.forEach(point => {
      const date = new Date(point.timestamp);
      const dayKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      
      if (!dailyProfiles.has(dayKey)) {
        dailyProfiles.set(dayKey, {
          date,
          solar: new Array(24).fill(0),
          load: new Array(24).fill(0),
          solarCounts: new Array(24).fill(0),
          loadCounts: new Array(24).fill(0)
        });
      }
      
      const hour = date.getHours();
      const profile = dailyProfiles.get(dayKey);
      profile.solar[hour] += point.power || 0;
      profile.solarCounts[hour]++;
    });
    
    // Add load data
    if (historicalData.load) {
      historicalData.load.forEach(point => {
        const date = new Date(point.timestamp);
        const dayKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
        
        if (dailyProfiles.has(dayKey)) {
          const hour = date.getHours();
          const profile = dailyProfiles.get(dayKey);
          profile.load[hour] += point.power || 0;
          profile.loadCounts[hour]++;
        }
      });
    }
    
    // Calculate averages and return as arrays
    return Array.from(dailyProfiles.values()).map(profile => {
      // Calculate hourly averages
      for (let h = 0; h < 24; h++) {
        if (profile.solarCounts[h] > 0) {
          profile.solar[h] /= profile.solarCounts[h];
        }
        if (profile.loadCounts[h] > 0) {
          profile.load[h] /= profile.loadCounts[h];
        }
      }
      
      return {
        date: profile.date,
        solar: profile.solar,
        load: profile.load,
        features: this.extractDailyFeatures(profile)
      };
    });
  }

  extractDailyFeatures(profile) {
    // Extract features for clustering
    const solarTotal = profile.solar.reduce((a, b) => a + b, 0);
    const loadTotal = profile.load.reduce((a, b) => a + b, 0);
    const solarPeak = Math.max(...profile.solar);
    const solarPeakHour = profile.solar.indexOf(solarPeak);
    const solarVariance = this.calculateVariance(profile.solar);
    const loadPeak = Math.max(...profile.load);
    const loadVariance = this.calculateVariance(profile.load);
    
    return [
      solarTotal / 1000,      // Normalize to kWh
      loadTotal / 1000,       // Normalize to kWh
      solarPeak / 1000,       // Normalize to kW
      solarPeakHour / 24,     // Normalize to 0-1
      solarVariance / 1000000, // Normalize variance
      loadPeak / 1000,        // Normalize to kW
      loadVariance / 1000000, // Normalize variance
      profile.date.getDay() / 7 // Day of week (0-1)
    ];
  }

  kMeansClustering(profiles, k) {
    if (profiles.length < k) return [profiles];
    
    // Initialize centroids randomly
    let centroids = [];
    for (let i = 0; i < k; i++) {
      const randomProfile = profiles[Math.floor(Math.random() * profiles.length)];
      centroids.push([...randomProfile.features]);
    }
    
    let clusters = [];
    let iterations = 0;
    const maxIterations = 50;
    
    while (iterations < maxIterations) {
      // Assign points to clusters
      clusters = Array(k).fill().map(() => []);
      
      profiles.forEach(profile => {
        let minDistance = Infinity;
        let closestCluster = 0;
        
        centroids.forEach((centroid, index) => {
          const distance = this.euclideanDistance(profile.features, centroid);
          if (distance < minDistance) {
            minDistance = distance;
            closestCluster = index;
          }
        });
        
        clusters[closestCluster].push(profile);
      });
      
      // Update centroids
      const newCentroids = [];
      clusters.forEach(cluster => {
        if (cluster.length === 0) {
          newCentroids.push([...centroids[0]]); // Fallback
          return;
        }
        
        const centroid = new Array(cluster[0].features.length).fill(0);
        cluster.forEach(profile => {
          profile.features.forEach((feature, index) => {
            centroid[index] += feature;
          });
        });
        
        centroid.forEach((sum, index) => {
          centroid[index] = sum / cluster.length;
        });
        
        newCentroids.push(centroid);
      });
      
      // Check convergence
      let converged = true;
      centroids.forEach((centroid, index) => {
        const distance = this.euclideanDistance(centroid, newCentroids[index]);
        if (distance > 0.01) converged = false;
      });
      
      centroids = newCentroids;
      iterations++;
      
      if (converged) break;
    }
    
    return clusters.filter(cluster => cluster.length > 0);
  }

  analyzeDailyCluster(cluster) {
    if (cluster.length === 0) return null;
    
    // Calculate average profiles for the cluster
    const avgSolar = new Array(24).fill(0);
    const avgLoad = new Array(24).fill(0);
    
    cluster.forEach(profile => {
      profile.solar.forEach((value, hour) => {
        avgSolar[hour] += value;
      });
      profile.load.forEach((value, hour) => {
        avgLoad[hour] += value;
      });
    });
    
    avgSolar.forEach((sum, hour) => {
      avgSolar[hour] = sum / cluster.length;
    });
    avgLoad.forEach((sum, hour) => {
      avgLoad[hour] = sum / cluster.length;
    });
    
    // Classify pattern type
    const solarTotal = avgSolar.reduce((a, b) => a + b, 0);
    const solarVariance = this.calculateVariance(avgSolar);
    const solarPeak = Math.max(...avgSolar);
    const solarPeakHour = avgSolar.indexOf(solarPeak);
    
    let patternType = 'mixed';
    if (solarVariance < 100000 && solarPeak > 2000) {
      patternType = 'sunny';
    } else if (solarTotal < 5000) {
      patternType = 'cloudy';
    } else if (solarVariance > 500000) {
      patternType = 'variable';
    }
    
    return {
      type: patternType,
      count: cluster.length,
      avgSolar,
      avgLoad,
      characteristics: {
        solarTotal,
        solarPeak,
        solarPeakHour,
        solarVariance,
        loadTotal: avgLoad.reduce((a, b) => a + b, 0),
        loadPeak: Math.max(...avgLoad)
      },
      confidence: Math.min(0.95, cluster.length / 10) // More samples = higher confidence
    };
  }

  async detectWeeklyPatterns(historicalData) {
    // Analyze weekly patterns (weekday vs weekend)
    const weeklyData = { weekday: [], weekend: [] };
    
    historicalData.solar.forEach(point => {
      const date = new Date(point.timestamp);
      const isWeekend = date.getDay() === 0 || date.getDay() === 6;
      
      if (isWeekend) {
        weeklyData.weekend.push(point);
      } else {
        weeklyData.weekday.push(point);
      }
    });
    
    // Analyze differences
    const weekdayAvg = this.calculateHourlyAverage(weeklyData.weekday);
    const weekendAvg = this.calculateHourlyAverage(weeklyData.weekend);
    
    this.patterns.weekly.set('weekday_vs_weekend', {
      weekday: weekdayAvg,
      weekend: weekendAvg,
      difference: weekdayAvg.map((w, i) => w - weekendAvg[i]),
      significance: this.calculateSignificance(weekdayAvg, weekendAvg)
    });
  }

  async detectSeasonalPatterns(historicalData) {
    // Group by months and detect seasonal transitions
    const monthlyData = new Map();
    
    historicalData.solar.forEach(point => {
      const month = new Date(point.timestamp).getMonth();
      if (!monthlyData.has(month)) {
        monthlyData.set(month, []);
      }
      monthlyData.get(month).push(point.power || 0);
    });
    
    // Calculate monthly averages and detect transitions
    const monthlyAverages = [];
    monthlyData.forEach((data, month) => {
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      monthlyAverages.push({ month, avg, samples: data.length });
    });
    
    // Detect seasonal transitions (significant changes between months)
    const transitions = [];
    for (let i = 1; i < monthlyAverages.length; i++) {
      const prev = monthlyAverages[i - 1];
      const curr = monthlyAverages[i];
      const change = (curr.avg - prev.avg) / prev.avg;
      
      if (Math.abs(change) > 0.2) { // 20% change threshold
        transitions.push({
          from: prev.month,
          to: curr.month,
          change: change,
          type: change > 0 ? 'increase' : 'decrease'
        });
      }
    }
    
    this.patterns.seasonal.set('monthly_transitions', {
      monthlyAverages,
      transitions,
      seasonalCycle: this.detectSeasonalCycle(monthlyAverages)
    });
  }

  async detectWeatherPatterns(historicalData) {
    // Infer weather patterns from solar production variance
    const dailyProfiles = this.extractDailyProfiles(historicalData);
    
    // Classify days by solar characteristics
    const weatherPatterns = {
      sunny: [],      // Low variance, high production
      cloudy: [],     // High variance, low production
      partlyCloudy: [], // Medium variance, medium production
      overcast: []    // Very low variance, very low production
    };
    
    dailyProfiles.forEach(profile => {
      const solarTotal = profile.solar.reduce((a, b) => a + b, 0);
      const solarVariance = this.calculateVariance(profile.solar);
      const solarPeak = Math.max(...profile.solar);
      
      // Classify based on production and variance
      if (solarPeak > 3000 && solarVariance < 500000) {
        weatherPatterns.sunny.push(profile);
      } else if (solarTotal < 2000 && solarVariance < 100000) {
        weatherPatterns.overcast.push(profile);
      } else if (solarVariance > 1000000) {
        weatherPatterns.cloudy.push(profile);
      } else {
        weatherPatterns.partlyCloudy.push(profile);
      }
    });
    
    // Calculate average patterns for each weather type
    Object.keys(weatherPatterns).forEach(weatherType => {
      const patterns = weatherPatterns[weatherType];
      if (patterns.length > 0) {
        const avgPattern = this.calculateAveragePattern(patterns);
        this.patterns.weather.set(weatherType, {
          count: patterns.length,
          avgSolar: avgPattern.solar,
          characteristics: avgPattern.characteristics,
          probability: patterns.length / dailyProfiles.length
        });
      }
    });
  }

  async detectAnomalies(historicalData) {
    // Detect unusual patterns or outliers
    const dailyProfiles = this.extractDailyProfiles(historicalData);
    
    // Calculate normal ranges
    const solarTotals = dailyProfiles.map(p => p.solar.reduce((a, b) => a + b, 0));
    const loadTotals = dailyProfiles.map(p => p.load.reduce((a, b) => a + b, 0));
    
    const solarMean = solarTotals.reduce((a, b) => a + b, 0) / solarTotals.length;
    const loadMean = loadTotals.reduce((a, b) => a + b, 0) / loadTotals.length;
    const solarStd = Math.sqrt(this.calculateVariance(solarTotals));
    const loadStd = Math.sqrt(this.calculateVariance(loadTotals));
    
    // Detect anomalies (values outside 2 standard deviations)
    dailyProfiles.forEach(profile => {
      const solarTotal = profile.solar.reduce((a, b) => a + b, 0);
      const loadTotal = profile.load.reduce((a, b) => a + b, 0);
      
      const solarZScore = Math.abs((solarTotal - solarMean) / solarStd);
      const loadZScore = Math.abs((loadTotal - loadMean) / loadStd);
      
      if (solarZScore > 2 || loadZScore > 2) {
        this.patterns.anomalies.push({
          date: profile.date,
          type: solarZScore > 2 ? 'solar_anomaly' : 'load_anomaly',
          severity: Math.max(solarZScore, loadZScore),
          solarTotal,
          loadTotal,
          description: this.describeAnomaly(solarZScore, loadZScore, profile)
        });
      }
    });
  }

  describeAnomaly(solarZScore, loadZScore, profile) {
    if (solarZScore > 2) {
      const solarTotal = profile.solar.reduce((a, b) => a + b, 0);
      return solarTotal > 10000 ? 'Exceptionally high solar production' : 'Exceptionally low solar production';
    }
    
    if (loadZScore > 2) {
      const loadTotal = profile.load.reduce((a, b) => a + b, 0);
      return loadTotal > 15000 ? 'Exceptionally high consumption' : 'Exceptionally low consumption';
    }
    
    return 'Unusual energy pattern detected';
  }

  getRelevantPatterns(currentTime) {
    const hour = currentTime.getHours();
    const dayOfWeek = currentTime.getDay();
    const month = currentTime.getMonth();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    
    const relevantPatterns = {
      timeContext: { hour, dayOfWeek, month, isWeekend },
      dailyPatterns: [],
      weeklyPattern: null,
      seasonalPattern: null,
      expectedWeather: null
    };
    
    // Get relevant daily patterns
    this.patterns.daily.forEach((pattern, key) => {
      if (pattern && pattern.avgSolar) {
        const expectedSolar = pattern.avgSolar[hour];
        const expectedLoad = pattern.avgLoad[hour];
        
        relevantPatterns.dailyPatterns.push({
          type: pattern.type,
          expectedSolar,
          expectedLoad,
          confidence: pattern.confidence
        });
      }
    });
    
    // Get weekly pattern
    if (this.patterns.weekly.has('weekday_vs_weekend')) {
      const weeklyPattern = this.patterns.weekly.get('weekday_vs_weekend');
      const expectedProfile = isWeekend ? weeklyPattern.weekend : weeklyPattern.weekday;
      
      relevantPatterns.weeklyPattern = {
        expected: expectedProfile[hour],
        type: isWeekend ? 'weekend' : 'weekday',
        significance: weeklyPattern.significance
      };
    }
    
    // Get seasonal pattern
    if (this.patterns.seasonal.has('monthly_transitions')) {
      const seasonalData = this.patterns.seasonal.get('monthly_transitions');
      const monthData = seasonalData.monthlyAverages.find(m => m.month === month);
      
      if (monthData) {
        relevantPatterns.seasonalPattern = {
          monthlyAvg: monthData.avg,
          samples: monthData.samples,
          transitions: seasonalData.transitions.filter(t => t.from === month || t.to === month)
        };
      }
    }
    
    // Predict likely weather pattern
    relevantPatterns.expectedWeather = this.predictWeatherPattern(currentTime);
    
    return relevantPatterns;
  }

  predictWeatherPattern(currentTime) {
    // Simple weather pattern prediction based on historical probabilities
    const weatherTypes = ['sunny', 'partlyCloudy', 'cloudy', 'overcast'];
    let bestMatch = null;
    let highestProbability = 0;
    
    weatherTypes.forEach(type => {
      if (this.patterns.weather.has(type)) {
        const pattern = this.patterns.weather.get(type);
        if (pattern.probability > highestProbability) {
          highestProbability = pattern.probability;
          bestMatch = {
            type,
            probability: pattern.probability,
            expectedSolar: pattern.avgSolar,
            confidence: Math.min(0.7, pattern.count / 50) // Max 70% confidence
          };
        }
      }
    });
    
    return bestMatch;
  }

  // Helper methods
  calculateHourlyAverage(data) {
    const hourlyTotals = new Array(24).fill(0);
    const hourlyCounts = new Array(24).fill(0);
    
    data.forEach(point => {
      const hour = new Date(point.timestamp).getHours();
      hourlyTotals[hour] += point.power || 0;
      hourlyCounts[hour]++;
    });
    
    return hourlyTotals.map((total, hour) => 
      hourlyCounts[hour] > 0 ? total / hourlyCounts[hour] : 0
    );
  }

  calculateAveragePattern(profiles) {
    const avgSolar = new Array(24).fill(0);
    const avgLoad = new Array(24).fill(0);
    
    profiles.forEach(profile => {
      profile.solar.forEach((value, hour) => avgSolar[hour] += value);
      profile.load.forEach((value, hour) => avgLoad[hour] += value);
    });
    
    avgSolar.forEach((sum, hour) => avgSolar[hour] = sum / profiles.length);
    avgLoad.forEach((sum, hour) => avgLoad[hour] = sum / profiles.length);
    
    return {
      solar: avgSolar,
      load: avgLoad,
      characteristics: {
        solarTotal: avgSolar.reduce((a, b) => a + b, 0),
        loadTotal: avgLoad.reduce((a, b) => a + b, 0),
        solarPeak: Math.max(...avgSolar),
        loadPeak: Math.max(...avgLoad)
      }
    };
  }

  calculateVariance(values) {
    if (values.length === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / values.length;
  }

  calculateSignificance(array1, array2) {
    // Simple significance test (difference in means)
    const mean1 = array1.reduce((a, b) => a + b, 0) / array1.length;
    const mean2 = array2.reduce((a, b) => a + b, 0) / array2.length;
    
    return Math.abs(mean1 - mean2) / Math.max(mean1, mean2);
  }

  euclideanDistance(point1, point2) {
    return Math.sqrt(
      point1.reduce((sum, val, index) => 
        sum + Math.pow(val - point2[index], 2), 0
      )
    );
  }

  detectSeasonalCycle(monthlyAverages) {
    // Detect if there's a clear seasonal cycle
    const values = monthlyAverages.map(m => m.avg);
    const maxMonth = monthlyAverages[values.indexOf(Math.max(...values))];
    const minMonth = monthlyAverages[values.indexOf(Math.min(...values))];
    
    return {
      peakMonth: maxMonth.month,
      peakValue: maxMonth.avg,
      lowMonth: minMonth.month,
      lowValue: minMonth.avg,
      amplitude: (maxMonth.avg - minMonth.avg) / minMonth.avg,
      cycleStrength: this.calculateCycleStrength(values)
    };
  }

  calculateCycleStrength(values) {
    // Simple measure of how cyclical the data is
    const variance = this.calculateVariance(values);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    
    return variance / (mean * mean); // Coefficient of variation squared
  }

  getStatus() {
    return {
      trained: this.trained,
      patterns: {
        daily: this.patterns.daily.size,
        weekly: this.patterns.weekly.size,
        seasonal: this.patterns.seasonal.size,
        weather: this.patterns.weather.size,
        anomalies: this.patterns.anomalies.length
      },
      clusterCount: this.clusterCount
    };
  }
}

module.exports = PatternDetector;