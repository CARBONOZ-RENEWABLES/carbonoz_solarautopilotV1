const Influx = require('influx');

class InfluxAIService {
  constructor() {
    this.influx = null;
    this.initialized = false;
    this.writeQueue = [];
    this.isWriting = false;
    this.initializeInflux();
  }

  initializeInflux() {
    try {
      this.influx = new Influx.InfluxDB({
        host: 'localhost',
        port: 8086,
        database: 'home_assistant',
        username: 'admin',
        password: 'adminpassword',
        protocol: 'http',
        timeout: 10000,
      });
      this.initialized = true;
      console.log('✅ InfluxDB AI Service initialized');
    } catch (error) {
      console.error('❌ Error initializing InfluxDB AI Service:', error.message);
      this.initialized = false;
    }
  }

  async saveDecision(decision, reasons, systemState, tibberData) {
    if (!this.initialized) {
      return false;
    }

    const point = {
      measurement: 'ai_decisions',
      tags: {
        decision_type: this.extractDecisionType(decision),
        source: 'AI_ENGINE'
      },
      fields: {
        decision: decision,
        reasons: JSON.stringify(reasons),
        battery_soc: systemState?.battery_soc || 0,
        pv_power: systemState?.pv_power || 0,
        load: systemState?.load || 0,
        grid_power: systemState?.grid_power || 0,
        grid_voltage: systemState?.grid_voltage || 0,
        current_price: tibberData?.currentPrice || 0,
        price_level: tibberData?.priceLevel || 'UNKNOWN',
        average_price: tibberData?.averagePrice || 0
      },
      timestamp: new Date()
    };

    this.queueWrite(point);
    return true;
  }

  async saveCommand(topic, value, success = true) {
    if (!this.initialized) {
      return false;
    }

    const point = {
      measurement: 'ai_commands',
      tags: {
        topic: topic,
        success: success.toString(),
        source: 'AI_ENGINE'
      },
      fields: {
        value: value.toString(),
        success_flag: success ? 1 : 0
      },
      timestamp: new Date()
    };

    this.queueWrite(point);
    return true;
  }

  async getDecisionHistory(limit = 50) {
    if (!this.initialized) {
      return [];
    }

    try {
      const query = `
        SELECT * FROM ai_decisions 
        ORDER BY time DESC 
        LIMIT ${limit}
      `;

      const result = await this.influx.query(query);
      
      return result.map(row => ({
        timestamp: row.time,
        decision: row.decision,
        reasons: this.parseReasons(row.reasons),
        systemState: {
          battery_soc: row.battery_soc,
          pv_power: row.pv_power,
          load: row.load,
          grid_power: row.grid_power,
          grid_voltage: row.grid_voltage
        },
        tibberData: {
          currentPrice: row.current_price,
          priceLevel: row.price_level,
          averagePrice: row.average_price
        }
      }));
    } catch (error) {
      console.error('Error retrieving AI decision history from InfluxDB:', error.message);
      return [];
    }
  }

  async getCommandHistory(limit = 50) {
    if (!this.initialized) {
      return [];
    }

    try {
      const query = `
        SELECT * FROM ai_commands 
        ORDER BY time DESC 
        LIMIT ${limit}
      `;

      const result = await this.influx.query(query);
      
      return result.map(row => ({
        timestamp: row.time,
        topic: row.topic,
        value: row.value,
        success: row.success === 'true',
        source: row.source
      }));
    } catch (error) {
      console.error('Error retrieving AI command history from InfluxDB:', error.message);
      return [];
    }
  }

  async getDecisionsByTimeRange(startTime, endTime) {
    if (!this.initialized) {
      return [];
    }

    try {
      const query = `
        SELECT * FROM ai_decisions 
        WHERE time >= '${startTime.toISOString()}' 
        AND time <= '${endTime.toISOString()}'
        ORDER BY time DESC
      `;

      const result = await this.influx.query(query);
      
      return result.map(row => ({
        timestamp: row.time,
        decision: row.decision,
        reasons: this.parseReasons(row.reasons),
        systemState: {
          battery_soc: row.battery_soc,
          pv_power: row.pv_power,
          load: row.load,
          grid_power: row.grid_power,
          grid_voltage: row.grid_voltage
        },
        tibberData: {
          currentPrice: row.current_price,
          priceLevel: row.price_level,
          averagePrice: row.average_price
        }
      }));
    } catch (error) {
      console.error('Error retrieving AI decisions by time range from InfluxDB:', error.message);
      return [];
    }
  }

  extractDecisionType(decision) {
    if (decision.includes('CHARGE')) return 'CHARGE';
    if (decision.includes('STOP')) return 'STOP';
    if (decision.includes('USE BATTERY')) return 'USE_BATTERY';
    if (decision.includes('USE SOLAR')) return 'USE_SOLAR';
    if (decision.includes('MONITOR')) return 'MONITOR';
    if (decision.includes('IDLE')) return 'IDLE';
    if (decision.includes('ERROR')) return 'ERROR';
    return 'OTHER';
  }

  parseReasons(reasonsString) {
    try {
      return JSON.parse(reasonsString);
    } catch (error) {
      return [reasonsString];
    }
  }

  queueWrite(point) {
    this.writeQueue.push(point);
    
    // Process queue when it reaches 10 points or after 30 seconds
    if (this.writeQueue.length >= 10) {
      this.processQueue();
    } else if (!this.queueTimer) {
      this.queueTimer = setTimeout(() => {
        this.processQueue();
      }, 30000);
    }
  }

  async processQueue() {
    if (this.isWriting || this.writeQueue.length === 0) {
      return;
    }

    this.isWriting = true;
    const pointsToWrite = [...this.writeQueue];
    this.writeQueue = [];
    
    if (this.queueTimer) {
      clearTimeout(this.queueTimer);
      this.queueTimer = null;
    }

    try {
      await this.influx.writePoints(pointsToWrite);
    } catch (error) {
      console.error('InfluxDB batch write error:', error.message);
    } finally {
      this.isWriting = false;
    }
  }

  async getTibberPriceDataCount(fromDate) {
    if (!this.initialized) {
      return 0;
    }

    try {
      const query = `
        SELECT COUNT(total) FROM tibber_prices 
        WHERE time >= '${fromDate.toISOString()}'
      `;

      const result = await this.influx.query(query);
      return result[0]?.count || 0;
    } catch (error) {
      console.error('Error getting Tibber price data count:', error.message);
      return 0;
    }
  }

  async getTibberPriceHistory(fromDate, toDate) {
    if (!this.initialized) {
      return [];
    }

    try {
      const query = `
        SELECT * FROM tibber_prices 
        WHERE time >= '${fromDate.toISOString()}' 
        AND time <= '${toDate.toISOString()}'
        ORDER BY time ASC
      `;

      const result = await this.influx.query(query);
      
      return result.map(row => ({
        timestamp: row.time,
        price: row.total || row.energy || 0,
        currency: row.currency,
        level: row.level,
        tax: row.tax
      }));
    } catch (error) {
      console.error('Error getting Tibber price history:', error.message);
      return [];
    }
  }
}

module.exports = new InfluxAIService();