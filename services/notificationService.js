// Notification Service for CARBONOZ SolarAutopilot
// Implements intelligent notification management with AI-aware logic

const fs = require('fs');
const path = require('path');
const telegramService = require('./telegramService');

class NotificationService {
    constructor() {
        this.notifications = new Map();
        this.notificationHistory = [];
        this.groupedNotifications = new Map();
        this.suppressionRules = new Map();
        this.conditionRules = new Map();
        this.thresholds = {
            batterySOC: { low: 20, critical: 10 },
            pvPower: { low: 500, high: 8000 },
            gridVoltage: { low: 200, high: 250 },
            price: { optimal: 8, expensive: 15, negative: 0 }
        };
        this.quietHours = { start: 22, end: 7 }; // 10 PM to 7 AM
        this.maxNotificationsPerHour = 10;
        this.lastNotificationTimes = new Map();
        this.loadConditionRules();
    }

    // Enhanced notification schema
    createNotification({
        id = this.generateId(),
        type, // 'ai_decision', 'system_alert', 'price_alert', 'battery_warning'
        severity, // 'info', 'warning', 'critical'
        title,
        message,
        source, // 'ai_engine', 'grid_monitor', 'battery_system', 'price_service'
        data = {},
        timestamp = new Date().toISOString(),
        inverterId = null,
        channels = ['ui'], // 'ui', 'telegram', 'email'
        priority = 'medium',
        groupKey = null,
        suppressionKey = null,
        expiresAt = null
    }) {
        const notification = {
            id,
            type,
            severity,
            title,
            message,
            source,
            data: {
                ...data,
                systemState: this.getCurrentSystemState(),
                metrics: this.extractKeyMetrics(data)
            },
            timestamp,
            inverterId,
            channels,
            priority,
            groupKey: groupKey || this.generateGroupKey(type, source),
            suppressionKey: suppressionKey || `${type}_${source}`,
            expiresAt,
            delivered: false,
            acknowledged: false,
            tags: this.generateTags(type, data)
        };

        return notification;
    }

    // AI-aware notification logic
    async processAIDecision(decision, systemState, tibberData) {
        const { decision: action, reasons, academicMetrics } = decision;
        
        // Only notify on significant AI decisions
        if (this.shouldNotifyAIDecision(action, systemState)) {
            const notification = this.createNotification({
                type: 'ai_decision',
                severity: this.getAISeverity(action, systemState),
                title: this.formatAITitle(action, systemState),
                message: this.formatAIMessage(action, reasons, systemState, tibberData),
                source: 'ai_engine',
                data: {
                    action,
                    reasons,
                    academicMetrics,
                    systemState,
                    tibberData,
                    batterySOC: systemState.battery_soc,
                    pvPower: systemState.pv_power,
                    load: systemState.load,
                    gridPower: systemState.grid_power,
                    currentPrice: tibberData.currentPrice?.total
                },
                channels: this.getAINotificationChannels(action),
                priority: this.getAIPriority(action, systemState),
                suppressionKey: `ai_${action.split(' ')[0].toLowerCase()}`
            });

            await this.processNotification(notification);
        }
    }

    // Smart notification processing with grouping and suppression
    async processNotification(notification) {
        // Check conditional rules first
        if (this.isBlockedByConditionRules(notification)) {
            console.log(`🚫 Notification blocked by condition rule: ${notification.title}`);
            return false;
        }

        // Check suppression rules
        if (this.isSuppressed(notification)) {
            console.log(`🔇 Notification suppressed: ${notification.suppressionKey}`);
            return false;
        }

        // Check quiet hours
        if (this.isQuietHours() && notification.severity !== 'critical') {
            console.log(`🌙 Notification delayed (quiet hours): ${notification.title}`);
            this.scheduleForLater(notification);
            return false;
        }

        // Check rate limiting
        if (this.isRateLimited(notification.source)) {
            console.log(`⏱️ Notification rate limited: ${notification.source}`);
            return false;
        }

        // Group similar notifications
        this.groupNotification(notification);

        // Store notification
        this.notifications.set(notification.id, notification);
        this.notificationHistory.unshift(notification);

        // Trim history
        if (this.notificationHistory.length > 1000) {
            this.notificationHistory = this.notificationHistory.slice(0, 1000);
        }

        // Deliver to channels
        await this.deliverNotification(notification);

        // Update suppression tracking
        this.updateSuppressionTracking(notification);

        return true;
    }

    // Intelligent grouping logic
    groupNotification(notification) {
        const groupKey = notification.groupKey;
        
        if (!this.groupedNotifications.has(groupKey)) {
            this.groupedNotifications.set(groupKey, {
                key: groupKey,
                type: notification.type,
                count: 0,
                firstSeen: notification.timestamp,
                lastSeen: notification.timestamp,
                notifications: [],
                summary: null
            });
        }

        const group = this.groupedNotifications.get(groupKey);
        group.count++;
        group.lastSeen = notification.timestamp;
        group.notifications.push(notification);

        // Keep only last 10 notifications per group
        if (group.notifications.length > 10) {
            group.notifications = group.notifications.slice(-10);
        }

        // Generate group summary for multiple notifications
        if (group.count > 1) {
            group.summary = this.generateGroupSummary(group);
        }
    }

    // Check if notification should be suppressed
    isSuppressed(notification) {
        const key = notification.suppressionKey;
        const now = Date.now();
        
        if (!this.suppressionRules.has(key)) {
            return false;
        }

        const rule = this.suppressionRules.get(key);
        const timeSinceLastNotification = now - rule.lastNotified;
        
        // Different cooldown periods based on severity
        const cooldownPeriods = {
            info: 30 * 60 * 1000,      // 30 minutes
            warning: 15 * 60 * 1000,   // 15 minutes
            critical: 5 * 60 * 1000    // 5 minutes
        };

        const cooldown = cooldownPeriods[notification.severity] || cooldownPeriods.info;
        
        return timeSinceLastNotification < cooldown;
    }

    // Update suppression tracking
    updateSuppressionTracking(notification) {
        this.suppressionRules.set(notification.suppressionKey, {
            lastNotified: Date.now(),
            count: (this.suppressionRules.get(notification.suppressionKey)?.count || 0) + 1
        });
    }

    // Check if it's quiet hours
    isQuietHours() {
        const now = new Date();
        const hour = now.getHours();
        
        if (this.quietHours.start > this.quietHours.end) {
            // Quiet hours span midnight
            return hour >= this.quietHours.start || hour < this.quietHours.end;
        } else {
            return hour >= this.quietHours.start && hour < this.quietHours.end;
        }
    }

    // Check rate limiting
    isRateLimited(source) {
        const now = Date.now();
        const hourAgo = now - (60 * 60 * 1000);
        
        if (!this.lastNotificationTimes.has(source)) {
            this.lastNotificationTimes.set(source, []);
        }

        const times = this.lastNotificationTimes.get(source);
        
        // Remove notifications older than 1 hour
        const recentTimes = times.filter(time => time > hourAgo);
        this.lastNotificationTimes.set(source, recentTimes);

        // Check if we've exceeded the limit
        if (recentTimes.length >= this.maxNotificationsPerHour) {
            return true;
        }

        // Add current time
        recentTimes.push(now);
        return false;
    }

    // Deliver notification to configured channels
    async deliverNotification(notification) {
        const deliveryResults = {};

        for (const channel of notification.channels) {
            try {
                switch (channel) {
                    case 'ui':
                        deliveryResults.ui = await this.deliverToUI(notification);
                        break;
                    case 'telegram':
                        deliveryResults.telegram = await this.deliverToTelegram(notification);
                        break;
                    case 'email':
                        deliveryResults.email = await this.deliverToEmail(notification);
                        break;
                }
            } catch (error) {
                console.error(`Failed to deliver notification to ${channel}:`, error);
                deliveryResults[channel] = { success: false, error: error.message };
            }
        }

        notification.delivered = Object.values(deliveryResults).some(result => result.success);
        notification.deliveryResults = deliveryResults;

        return deliveryResults;
    }

    // Deliver to Telegram with enhanced formatting
    async deliverToTelegram(notification) {
        try {
            const success = await telegramService.sendEnhancedNotification(notification);
            return { success, timestamp: new Date().toISOString() };
        } catch (error) {
            console.error('Failed to send Telegram notification:', error);
            return { success: false, error: error.message };
        }
    }

    // Format enhanced Telegram message
    formatTelegramMessage(notification) {
        const { title, message, data, severity, timestamp } = notification;
        const severityEmoji = { info: '🔵', warning: '🟡', critical: '🔴' };
        
        let telegramMessage = `${severityEmoji[severity]} *${title}*\n\n`;
        telegramMessage += `${message}\n\n`;

        // Add key metrics if available
        if (data.metrics && Object.keys(data.metrics).length > 0) {
            telegramMessage += `📊 *Key Metrics:*\n`;
            
            if (data.metrics.batterySOC !== undefined) {
                telegramMessage += `🔋 Battery: ${data.metrics.batterySOC}%\n`;
            }
            if (data.metrics.pvPower !== undefined) {
                telegramMessage += `☀️ Solar: ${data.metrics.pvPower}W\n`;
            }
            if (data.metrics.load !== undefined) {
                telegramMessage += `⚡ Load: ${data.metrics.load}W\n`;
            }
            if (data.metrics.currentPrice !== undefined) {
                telegramMessage += `💰 Price: ${data.metrics.currentPrice}¢/kWh\n`;
            }
            
            telegramMessage += '\n';
        }

        // Add inverter info if available
        if (notification.inverterId) {
            telegramMessage += `🔌 Inverter: ${notification.inverterId}\n`;
        }

        telegramMessage += `🕐 ${new Date(timestamp).toLocaleString()}`;

        return telegramMessage;
    }

    // AI decision notification logic
    shouldNotifyAIDecision(action, systemState) {
        // Only notify on significant state changes
        const significantActions = [
            'CHARGE GRID',
            'STOP CHARGING',
            'DISCHARGE',
            'NEGATIVE PRICE ARBITRAGE'
        ];

        return significantActions.some(significant => action.includes(significant));
    }

    getAISeverity(action, systemState) {
        if (action.includes('NEGATIVE PRICE') || systemState.battery_soc < 15) {
            return 'critical';
        }
        if (action.includes('CHARGE') || action.includes('STOP')) {
            return 'warning';
        }
        return 'info';
    }

    formatAITitle(action, systemState) {
        if (action.includes('NEGATIVE PRICE')) {
            return '💸 Negative Price Opportunity!';
        }
        if (action.includes('CHARGE GRID')) {
            return '🔋 AI Started Grid Charging';
        }
        if (action.includes('STOP CHARGING')) {
            return '⏹️ AI Stopped Charging';
        }
        if (action.includes('DISCHARGE')) {
            return '⚡ AI Peak Discharge Active';
        }
        return '🤖 AI Decision Update';
    }

    formatAIMessage(action, reasons, systemState, tibberData) {
        let message = `AI Engine: ${action}\n\n`;
        
        if (reasons && reasons.length > 0) {
            message += `Reasoning:\n${reasons.map(r => `• ${r}`).join('\n')}\n\n`;
        }

        return message.trim();
    }

    getAINotificationChannels(action) {
        // Critical actions go to all channels
        if (action.includes('NEGATIVE PRICE') || action.includes('CRITICAL')) {
            return ['ui', 'telegram'];
        }
        
        // Important actions go to UI and Telegram if configured
        if (action.includes('CHARGE') || action.includes('STOP')) {
            return ['ui', 'telegram'];
        }
        
        // Regular updates only to UI
        return ['ui'];
    }

    getAIPriority(action, systemState) {
        if (action.includes('NEGATIVE PRICE') || systemState.battery_soc < 10) {
            return 'high';
        }
        if (action.includes('CHARGE') || action.includes('STOP')) {
            return 'medium';
        }
        return 'low';
    }

    // System monitoring notifications
    async checkSystemThresholds(systemState) {
        const notifications = [];

        // Battery SOC warnings
        if (systemState.battery_soc <= this.thresholds.batterySOC.critical) {
            notifications.push(this.createNotification({
                type: 'battery_warning',
                severity: 'critical',
                title: '🔋 Critical Battery Level',
                message: `Battery SOC is critically low at ${systemState.battery_soc}%. Immediate charging recommended.`,
                source: 'battery_system',
                data: { batterySOC: systemState.battery_soc },
                channels: ['ui', 'telegram'],
                priority: 'high',
                suppressionKey: 'battery_critical'
            }));
        } else if (systemState.battery_soc <= this.thresholds.batterySOC.low) {
            notifications.push(this.createNotification({
                type: 'battery_warning',
                severity: 'warning',
                title: '🔋 Low Battery Level',
                message: `Battery SOC is low at ${systemState.battery_soc}%. Consider charging soon.`,
                source: 'battery_system',
                data: { batterySOC: systemState.battery_soc },
                suppressionKey: 'battery_low'
            }));
        }

        // Grid voltage warnings
        if (systemState.grid_voltage < this.thresholds.gridVoltage.low || 
            systemState.grid_voltage > this.thresholds.gridVoltage.high) {
            notifications.push(this.createNotification({
                type: 'system_alert',
                severity: 'critical',
                title: '⚡ Grid Voltage Issue',
                message: `Grid voltage is ${systemState.grid_voltage}V (normal: 200-250V). System protection may activate.`,
                source: 'grid_monitor',
                data: { gridVoltage: systemState.grid_voltage },
                channels: ['ui', 'telegram'],
                priority: 'high',
                suppressionKey: 'grid_voltage'
            }));
        }

        // Process all notifications
        for (const notification of notifications) {
            await this.processNotification(notification);
        }

        return notifications;
    }

    // Price alert notifications
    async checkPriceAlerts(priceData) {
        const notifications = [];
        const currentPrice = priceData.currentPrice?.total;

        if (currentPrice === undefined) return notifications;

        // Negative price alert
        if (currentPrice < this.thresholds.price.negative) {
            notifications.push(this.createNotification({
                type: 'price_alert',
                severity: 'critical',
                title: '💸 Negative Electricity Prices!',
                message: `You're getting paid ${Math.abs(currentPrice).toFixed(2)}¢/kWh to use electricity! Maximum charging recommended.`,
                source: 'price_service',
                data: { currentPrice, priceLevel: 'negative' },
                channels: ['ui', 'telegram'],
                priority: 'high',
                suppressionKey: 'price_negative'
            }));
        }
        // Optimal price alert
        else if (currentPrice <= this.thresholds.price.optimal) {
            notifications.push(this.createNotification({
                type: 'price_alert',
                severity: 'info',
                title: '💰 Optimal Charging Price',
                message: `Electricity price is ${currentPrice.toFixed(2)}¢/kWh - optimal for battery charging!`,
                source: 'price_service',
                data: { currentPrice, priceLevel: 'optimal' },
                suppressionKey: 'price_optimal'
            }));
        }
        // Expensive price warning
        else if (currentPrice >= this.thresholds.price.expensive) {
            notifications.push(this.createNotification({
                type: 'price_alert',
                severity: 'warning',
                title: '💸 High Electricity Prices',
                message: `Electricity price is ${currentPrice.toFixed(2)}¢/kWh - avoid charging if possible.`,
                source: 'price_service',
                data: { currentPrice, priceLevel: 'expensive' },
                suppressionKey: 'price_expensive'
            }));
        }

        // Process all notifications
        for (const notification of notifications) {
            await this.processNotification(notification);
        }

        return notifications;
    }

    // Utility methods
    generateId() {
        return `notif_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    generateGroupKey(type, source) {
        return `${type}_${source}`;
    }

    generateTags(type, data) {
        const tags = [type];
        
        if (data.batterySOC !== undefined) tags.push('battery');
        if (data.pvPower !== undefined) tags.push('solar');
        if (data.currentPrice !== undefined) tags.push('price');
        if (data.gridPower !== undefined) tags.push('grid');
        
        return tags;
    }

    extractKeyMetrics(data) {
        const metrics = {};
        
        if (data.batterySOC !== undefined) metrics.batterySOC = data.batterySOC;
        if (data.pvPower !== undefined) metrics.pvPower = data.pvPower;
        if (data.load !== undefined) metrics.load = data.load;
        if (data.currentPrice !== undefined) metrics.currentPrice = data.currentPrice;
        if (data.gridVoltage !== undefined) metrics.gridVoltage = data.gridVoltage;
        
        return metrics;
    }

    getCurrentSystemState() {
        // This should be injected from the main system
        return global.currentSystemState || {};
    }

    // API methods for frontend
    getNotifications(filters = {}) {
        let notifications = Array.from(this.notifications.values());
        
        // Apply filters
        if (filters.severity) {
            notifications = notifications.filter(n => n.severity === filters.severity);
        }
        if (filters.type) {
            notifications = notifications.filter(n => n.type === filters.type);
        }
        if (filters.source) {
            notifications = notifications.filter(n => n.source === filters.source);
        }
        if (filters.since) {
            const since = new Date(filters.since);
            notifications = notifications.filter(n => new Date(n.timestamp) >= since);
        }

        // Sort by timestamp (newest first)
        notifications.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        return notifications;
    }

    getGroupedNotifications() {
        return Array.from(this.groupedNotifications.values());
    }

    acknowledgeNotification(id) {
        const notification = this.notifications.get(id);
        if (notification) {
            notification.acknowledged = true;
            return true;
        }
        return false;
    }

    clearNotifications(filters = {}) {
        if (Object.keys(filters).length === 0) {
            // Clear all
            this.notifications.clear();
            this.groupedNotifications.clear();
            return true;
        }

        // Clear with filters
        const toDelete = [];
        for (const [id, notification] of this.notifications) {
            let shouldDelete = true;
            
            if (filters.severity && notification.severity !== filters.severity) {
                shouldDelete = false;
            }
            if (filters.type && notification.type !== filters.type) {
                shouldDelete = false;
            }
            if (filters.acknowledged !== undefined && notification.acknowledged !== filters.acknowledged) {
                shouldDelete = false;
            }
            
            if (shouldDelete) {
                toDelete.push(id);
            }
        }

        toDelete.forEach(id => this.notifications.delete(id));
        return toDelete.length;
    }

    // Configuration methods
    updateThresholds(newThresholds) {
        this.thresholds = { ...this.thresholds, ...newThresholds };
    }

    updateQuietHours(start, end) {
        this.quietHours = { start, end };
    }

    updateRateLimit(maxPerHour) {
        this.maxNotificationsPerHour = maxPerHour;
    }

    // Conditional rules management
    loadConditionRules() {
        try {
            const rulesPath = path.join(__dirname, '../data/condition-rules.json');
            if (fs.existsSync(rulesPath)) {
                const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
                rules.forEach(rule => {
                    this.conditionRules.set(rule.id, rule);
                });
            }
        } catch (error) {
            console.error('Error loading condition rules:', error);
        }
    }

    saveConditionRules() {
        try {
            const rulesPath = path.join(__dirname, '../data/condition-rules.json');
            const dataDir = path.dirname(rulesPath);
            
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            
            const rules = Array.from(this.conditionRules.values());
            fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2));
        } catch (error) {
            console.error('Error saving condition rules:', error);
        }
    }

    addConditionRule(ruleData) {
        const rule = {
            id: `rule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            ...ruleData,
            createdAt: new Date().toISOString()
        };
        
        this.conditionRules.set(rule.id, rule);
        this.saveConditionRules();
        return rule;
    }

    getConditionRules() {
        return Array.from(this.conditionRules.values());
    }

    toggleConditionRule(ruleId) {
        const rule = this.conditionRules.get(ruleId);
        if (rule) {
            rule.enabled = !rule.enabled;
            this.saveConditionRules();
            return true;
        }
        return false;
    }

    deleteConditionRule(ruleId) {
        const success = this.conditionRules.delete(ruleId);
        if (success) {
            this.saveConditionRules();
        }
        return success;
    }

    isBlockedByConditionRules(notification) {
        const systemState = this.getCurrentSystemState();
        
        for (const rule of this.conditionRules.values()) {
            if (!rule.enabled) continue;
            
            // Check if rule applies to this notification
            if (rule.type !== 'all' && rule.type !== notification.type) continue;
            if (rule.severity !== 'all' && rule.severity !== notification.severity) continue;
            
            // Check if all conditions are met
            const conditionsMet = rule.conditions.every(condition => {
                const value = this.getSystemValue(systemState, condition.param);
                if (value === null || value === undefined) return false;
                
                switch (condition.operator) {
                    case 'lt': return value < condition.value;
                    case 'lte': return value <= condition.value;
                    case 'gt': return value > condition.value;
                    case 'gte': return value >= condition.value;
                    case 'eq': return value === condition.value;
                    case 'ne': return value !== condition.value;
                    default: return false;
                }
            });
            
            // If conditions are met and action is suppress, block the notification
            if (conditionsMet && rule.action === 'suppress') {
                console.log(`🚫 Notification blocked by rule: ${rule.name}`);
                return true;
            }
        }
        
        return false;
    }

    getSystemValue(systemState, param) {
        switch (param) {
            case 'battery_soc': return systemState.battery_soc;
            case 'pv_power': return systemState.pv_power;
            case 'load': return systemState.load;
            case 'grid_power': return systemState.grid_power;
            case 'grid_voltage': return systemState.grid_voltage;
            case 'current_price': return systemState.current_price;
            default: return null;
        }
    }

    clearAllNotifications() {
        this.notifications.clear();
        this.notificationHistory = [];
        this.groupedNotifications.clear();
        this.suppressionRules.clear();
        console.log('All notifications cleared');
    }
}

module.exports = new NotificationService();