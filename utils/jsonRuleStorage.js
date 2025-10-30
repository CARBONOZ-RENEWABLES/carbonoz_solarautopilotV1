const fs = require('fs');
const path = require('path');

class JsonRuleStorage {
  constructor(dataDir = path.join(__dirname, '..', 'data')) {
    this.dataDir = dataDir;
    this.rulesFile = path.join(dataDir, 'rules.json');
    
    // Ensure data directory exists
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    // Initialize files if they don't exist
    this.initializeFiles();
  }

  initializeFiles() {
    if (!fs.existsSync(this.rulesFile)) {
      fs.writeFileSync(this.rulesFile, JSON.stringify([], null, 2));
    }
  }

  // Rules methods
  saveRule(ruleData) {
    try {
      const rules = this.getAllRules();
      const newRule = {
        id: this.generateId(),
        name: ruleData.name,
        description: ruleData.description || '',
        active: ruleData.active || false,
        conditions: Array.isArray(ruleData.conditions) ? ruleData.conditions : [],
        timeRestrictions: (ruleData.timeRestrictions && typeof ruleData.timeRestrictions === 'object') ? ruleData.timeRestrictions : {},
        actions: Array.isArray(ruleData.actions) ? ruleData.actions : [],
        createdAt: new Date().toISOString(),
        lastTriggered: ruleData.lastTriggered ? ruleData.lastTriggered.toISOString() : null,
        triggerCount: ruleData.triggerCount || 0,
        user_id: ruleData.user_id,
        mqtt_username: ruleData.mqtt_username
      };
      
      rules.push(newRule);
      fs.writeFileSync(this.rulesFile, JSON.stringify(rules, null, 2));
      
      return newRule;
    } catch (error) {
      console.error('Error saving rule to JSON:', error.message);
      return null;
    }
  }

  updateRule(id, ruleData) {
    try {
      const rules = this.getAllRules();
      const ruleIndex = rules.findIndex(rule => rule.id == id && rule.user_id === ruleData.user_id);
      
      if (ruleIndex === -1) return false;
      
      rules[ruleIndex] = {
        ...rules[ruleIndex],
        name: ruleData.name,
        description: ruleData.description || '',
        active: ruleData.active !== undefined ? !!ruleData.active : rules[ruleIndex].active,
        conditions: Array.isArray(ruleData.conditions) ? ruleData.conditions : [],
        timeRestrictions: (ruleData.timeRestrictions && typeof ruleData.timeRestrictions === 'object') ? ruleData.timeRestrictions : {},
        actions: Array.isArray(ruleData.actions) ? ruleData.actions : [],
        lastTriggered: ruleData.lastTriggered ? ruleData.lastTriggered.toISOString() : rules[ruleIndex].lastTriggered,
        triggerCount: ruleData.triggerCount || rules[ruleIndex].triggerCount
      };
      
      fs.writeFileSync(this.rulesFile, JSON.stringify(rules, null, 2));
      return true;
    } catch (error) {
      console.error('Error updating rule in JSON:', error.message);
      return false;
    }
  }

  getAllRules(userId = null, options = {}) {
    try {
      const data = fs.readFileSync(this.rulesFile, 'utf8');
      let rules = JSON.parse(data);
      
      // Filter by user ID if provided
      if (userId) {
        rules = rules.filter(rule => rule.user_id === userId);
      }
      
      // Filter by active status if specified
      if (options.active !== undefined) {
        rules = rules.filter(rule => rule.active === options.active);
      }
      
      // Apply sorting
      if (options.sort) {
        const { field, order } = options.sort;
        rules.sort((a, b) => {
          const aVal = a[field];
          const bVal = b[field];
          if (order === 'DESC') {
            return bVal > aVal ? 1 : -1;
          }
          return aVal > bVal ? 1 : -1;
        });
      }
      
      // Apply pagination
      if (options.limit) {
        const start = options.offset || 0;
        rules = rules.slice(start, start + options.limit);
      }
      
      // Convert date strings back to Date objects
      return rules.map(rule => ({
        ...rule,
        createdAt: rule.createdAt ? new Date(rule.createdAt) : null,
        lastTriggered: rule.lastTriggered ? new Date(rule.lastTriggered) : null
      }));
    } catch (error) {
      console.error('Error getting rules from JSON:', error.message);
      return [];
    }
  }

  getRuleById(id, userId) {
    try {
      const rules = this.getAllRules();
      const rule = rules.find(rule => rule.id == id && rule.user_id === userId);
      
      if (!rule) return null;
      
      return {
        ...rule,
        createdAt: rule.createdAt ? new Date(rule.createdAt) : null,
        lastTriggered: rule.lastTriggered ? new Date(rule.lastTriggered) : null
      };
    } catch (error) {
      console.error('Error getting rule by ID from JSON:', error.message);
      return null;
    }
  }

  deleteRule(id, userId) {
    try {
      const rules = this.getAllRules();
      const filteredRules = rules.filter(rule => !(rule.id == id && rule.user_id === userId));
      
      if (filteredRules.length === rules.length) return false;
      
      fs.writeFileSync(this.rulesFile, JSON.stringify(filteredRules, null, 2));
      return true;
    } catch (error) {
      console.error('Error deleting rule from JSON:', error.message);
      return false;
    }
  }

  countRules(userId) {
    try {
      const rules = this.getAllRules(userId);
      return rules.length;
    } catch (error) {
      console.error('Error counting rules:', error.message);
      return 0;
    }
  }

  batchUpdateRules(rules) {
    try {
      const allRules = this.getAllRules();
      
      rules.forEach(updatedRule => {
        const ruleIndex = allRules.findIndex(rule => 
          rule.id == updatedRule.id && rule.user_id === updatedRule.user_id
        );
        
        if (ruleIndex !== -1) {
          allRules[ruleIndex].lastTriggered = updatedRule.lastTriggered.toISOString();
          allRules[ruleIndex].triggerCount = updatedRule.triggerCount;
        }
      });
      
      fs.writeFileSync(this.rulesFile, JSON.stringify(allRules, null, 2));
      return true;
    } catch (error) {
      console.error('Error batch updating rules in JSON:', error.message);
      return false;
    }
  }



  // Utility methods
  generateId() {
    return Date.now() + Math.random().toString(36).substr(2, 9);
  }

  parseJsonOrValue(value) {
    if (!value) return value;
    
    try {
      if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
        return JSON.parse(value);
      }
    } catch (e) {
      // Not JSON, just return the value
    }
    
    return value;
  }

  // Migration method to import from SQLite
  migrateFromSQLite(db) {
    try {
      console.log('Starting migration from SQLite to JSON...');
      
      // Migrate rules
      const rulesStmt = db.prepare('SELECT * FROM rules');
      const sqliteRules = rulesStmt.all();
      
      const jsonRules = sqliteRules.map(rule => ({
        id: rule.id,
        name: rule.name,
        description: rule.description,
        active: rule.active === 1,
        conditions: JSON.parse(rule.conditions || '[]'),
        timeRestrictions: JSON.parse(rule.time_restrictions || '{}'),
        actions: JSON.parse(rule.actions || '[]'),
        createdAt: rule.created_at,
        lastTriggered: rule.last_triggered,
        triggerCount: rule.trigger_count,
        user_id: rule.user_id,
        mqtt_username: rule.mqtt_username
      }));
      
      fs.writeFileSync(this.rulesFile, JSON.stringify(jsonRules, null, 2));
      console.log(`Migrated ${jsonRules.length} rules to JSON`);
      
      // Migrate settings changes
      const changesStmt = db.prepare('SELECT * FROM settings_changes ORDER BY timestamp DESC LIMIT 5000');
      const sqliteChanges = changesStmt.all();
      
      const jsonChanges = sqliteChanges.map(change => ({
        id: change.id,
        timestamp: change.timestamp,
        topic: change.topic,
        old_value: change.old_value,
        new_value: change.new_value,
        system_state: change.system_state,
        change_type: change.change_type,
        user_id: change.user_id,
        mqtt_username: change.mqtt_username
      }));
      
      fs.writeFileSync(this.settingsChangesFile, JSON.stringify(jsonChanges, null, 2));
      console.log(`Migrated ${jsonChanges.length} settings changes to JSON`);
      
      console.log('Migration completed successfully!');
      return true;
    } catch (error) {
      console.error('Error during migration:', error.message);
      return false;
    }
  }
}

module.exports = JsonRuleStorage;