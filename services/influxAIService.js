const Influx = require('influx');

class InfluxAIService {
  constructor() {
    this.influx = null;
    this.initialized = false;
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
      console.error('InfluxDB not initialized, decision not saved');
      return false;
    }

    try {
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

      await this.influx.writePoints([point]);
      return true;
    } catch (error) {
      console.error('Error saving AI decision to InfluxDB:', error.message);
      return false;
    }
  }

  async saveCommand(topic, value, success = true) {
    if (!this.initialized) {
      console.error('InfluxDB not initialized, command not saved');
      return false;
    }

    try {
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

      await this.influx.writePoints([point]);
      return true;
    } catch (error) {
      console.error('Error saving AI command to InfluxDB:', error.message);
      return false;
    }
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
}

module.exports = new InfluxAIService();