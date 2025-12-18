// Notifications Frontend for CARBONOZ SolarAutopilot
// Implements real-time notification management with smart grouping and filtering

class NotificationManager {
    constructor() {
        this.notifications = new Map();
        this.groupedNotifications = new Map();
        this.filters = {
            severity: 'all',
            type: 'all',
            source: 'all',
            timeRange: '24h'
        };
        this.currentFilter = 'all';
        this.settings = {
            enableSound: true,
            enableDesktop: true,
            maxVisible: 50,
            autoAcknowledge: false,
            groupSimilar: true
        };
        this.soundEnabled = true;
        this.container = null;
        this.toastContainer = null;
        this.init();
    }

    init() {
        this.createContainers();
        this.loadSettings();
        this.setupEventListeners();
        this.startPolling();
        this.requestNotificationPermission();
    }

    createContainers() {
        // Main notification container
        this.container = document.getElementById('notifications-container') || this.createNotificationContainer();
        
        // Toast container for real-time notifications
        this.toastContainer = document.getElementById('toast-container') || this.createToastContainer();
    }

    createNotificationContainer() {
        const container = document.createElement('div');
        container.id = 'notifications-container';
        container.className = 'notifications-container';
        
        // Find the main content area and append
        const mainContent = document.querySelector('.main-content .container');
        if (mainContent) {
            mainContent.appendChild(container);
        }
        
        return container;
    }

    createToastContainer() {
        const container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        document.body.appendChild(container);
        return container;
    }

    // Real-time notification polling
    startPolling() {
        this.loadNotifications();
        
        // Poll every 30 seconds for new notifications
        setInterval(() => {
            this.loadNotifications();
        }, 30000);
    }

    async loadNotifications() {
        try {
            const response = await fetch('/api/notifications', {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            
            if (data.success) {
                this.processNotifications(data.notifications);
                this.processGroupedNotifications(data.grouped);
            }
        } catch (error) {
            console.error('Failed to load notifications:', error);
        }
    }

    processNotifications(notifications) {
        const existingIds = new Set(this.notifications.keys());
        const newNotifications = [];

        notifications.forEach(notification => {
            if (!existingIds.has(notification.id)) {
                newNotifications.push(notification);
                this.showToastNotification(notification);
            }
            this.notifications.set(notification.id, notification);
        });

        // Remove old notifications not in the new set
        const currentIds = new Set(notifications.map(n => n.id));
        for (const id of existingIds) {
            if (!currentIds.has(id)) {
                this.notifications.delete(id);
            }
        }

        this.renderNotifications();

        // Play sound for new critical notifications
        if (newNotifications.some(n => n.severity === 'critical') && this.soundEnabled) {
            this.playNotificationSound();
        }
    }

    processGroupedNotifications(grouped) {
        this.groupedNotifications.clear();
        grouped.forEach(group => {
            this.groupedNotifications.set(group.key, group);
        });
    }

    renderNotifications() {
        if (!this.container) return;

        let filteredNotifications = Array.from(this.notifications.values());
        
        // Apply current filter
        if (this.currentFilter !== 'all') {
            filteredNotifications = filteredNotifications.filter(notification => {
                if (this.currentFilter === 'critical' || this.currentFilter === 'warning' || this.currentFilter === 'info') {
                    return notification.severity === this.currentFilter;
                }
                if (this.currentFilter === 'ai_decision' || this.currentFilter === 'price_alert') {
                    return notification.type === this.currentFilter;
                }
                return true;
            });
        }
        
        // Sort by timestamp (newest first)
        filteredNotifications.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        
        // Apply display limit
        const displayNotifications = filteredNotifications.slice(0, this.settings.maxVisible);
        
        // Clear container
        this.container.innerHTML = '';

        // Add notifications
        if (displayNotifications.length === 0) {
            this.container.appendChild(this.createEmptyState());
        } else {
            if (this.settings.groupSimilar) {
                this.renderGroupedNotifications(displayNotifications);
            } else {
                this.renderFlatNotifications(displayNotifications);
            }
        }
    }

    createFiltersSection() {
        const section = document.createElement('div');
        section.className = 'notification-filters';
        
        section.innerHTML = `
            <div class="filter-chip ${this.filters.severity === 'all' ? 'active' : ''}" data-filter="severity" data-value="all">
                All Severities
            </div>
            <div class="filter-chip ${this.filters.severity === 'critical' ? 'active' : ''}" data-filter="severity" data-value="critical">
                🔴 Critical
            </div>
            <div class="filter-chip ${this.filters.severity === 'warning' ? 'active' : ''}" data-filter="severity" data-value="warning">
                🟡 Warning
            </div>
            <div class="filter-chip ${this.filters.severity === 'info' ? 'active' : ''}" data-filter="severity" data-value="info">
                🔵 Info
            </div>
            <div class="filter-chip ${this.filters.type === 'ai_decision' ? 'active' : ''}" data-filter="type" data-value="ai_decision">
                🤖 AI Decisions
            </div>
            <div class="filter-chip ${this.filters.type === 'price_alert' ? 'active' : ''}" data-filter="type" data-value="price_alert">
                💰 Price Alerts
            </div>
        `;

        // Add event listeners
        section.querySelectorAll('.filter-chip').forEach(chip => {
            chip.addEventListener('click', (e) => {
                const filterType = e.target.dataset.filter;
                const filterValue = e.target.dataset.value;
                
                this.filters[filterType] = filterValue;
                this.renderNotifications();
            });
        });

        return section;
    }

    renderGroupedNotifications(notifications) {
        const groups = this.groupNotificationsByKey(notifications);
        
        groups.forEach(group => {
            this.container.appendChild(this.createNotificationGroup(group));
        });
    }

    renderFlatNotifications(notifications) {
        notifications.forEach(notification => {
            this.container.appendChild(this.createNotificationElement(notification));
        });
    }

    createNotificationGroup(group) {
        const groupElement = document.createElement('div');
        groupElement.className = 'notification-group';
        
        const header = document.createElement('div');
        header.className = 'notification-group-header';
        header.innerHTML = `
            <div class="notification-group-title">
                <i class="fas fa-layer-group"></i>
                ${this.getGroupTitle(group)}
                <span class="notification-group-count">${group.notifications.length}</span>
            </div>
            <button class="notification-group-toggle">
                <i class="fas fa-chevron-down"></i>
            </button>
        `;

        const items = document.createElement('div');
        items.className = 'notification-group-items';
        
        group.notifications.forEach(notification => {
            items.appendChild(this.createNotificationElement(notification, true));
        });

        // Toggle functionality
        header.querySelector('.notification-group-toggle').addEventListener('click', () => {
            groupElement.classList.toggle('collapsed');
        });

        groupElement.appendChild(header);
        groupElement.appendChild(items);
        
        return groupElement;
    }

    createNotificationElement(notification, isGrouped = false) {
        const element = document.createElement('div');
        element.className = `notification-container ${notification.severity} ${notification.acknowledged ? 'acknowledged' : ''}`;
        element.dataset.id = notification.id;

        const timeAgo = this.getTimeAgo(notification.timestamp);
        const severityIcon = this.getSeverityIcon(notification.severity);

        element.innerHTML = `
            <div class="notification-header">
                <div class="notification-icon-wrapper">
                    <div class="notification-icon ${notification.severity}">
                        ${severityIcon}
                    </div>
                    <div class="notification-title-group">
                        <h4 class="notification-title">${notification.title}</h4>
                        <p class="notification-subtitle">${this.getSourceLabel(notification.source)}</p>
                    </div>
                </div>
                <div class="notification-timestamp">
                    <i class="fas fa-clock"></i>
                    ${timeAgo}
                </div>
            </div>
            <div class="notification-body">
                <p class="notification-description">${notification.message}</p>
                ${this.createMetricsSection(notification.data.metrics)}
                ${this.createTagsSection(notification.tags)}
                <div class="notification-actions">
                    ${!notification.acknowledged ? `<button class="notification-btn primary" onclick="notificationManager.acknowledgeNotification('${notification.id}')">Acknowledge</button>` : ''}
                    <button class="notification-btn secondary" onclick="notificationManager.showDetails('${notification.id}')">Details</button>
                </div>
            </div>
        `;

        return element;
    }

    createMetricsSection(metrics) {
        if (!metrics || Object.keys(metrics).length === 0) {
            return '';
        }

        let html = '<div class="notification-metrics">';
        
        if (metrics.batterySOC !== undefined) {
            html += `
                <div class="metric-item">
                    <div class="metric-label">Battery SOC</div>
                    <div class="metric-value">${metrics.batterySOC}<span class="metric-unit">%</span></div>
                </div>
            `;
        }
        
        if (metrics.pvPower !== undefined) {
            html += `
                <div class="metric-item">
                    <div class="metric-label">Solar Power</div>
                    <div class="metric-value">${metrics.pvPower}<span class="metric-unit">W</span></div>
                </div>
            `;
        }
        
        if (metrics.load !== undefined) {
            html += `
                <div class="metric-item">
                    <div class="metric-label">Load</div>
                    <div class="metric-value">${metrics.load}<span class="metric-unit">W</span></div>
                </div>
            `;
        }
        
        if (metrics.currentPrice !== undefined) {
            html += `
                <div class="metric-item">
                    <div class="metric-label">Price</div>
                    <div class="metric-value">${metrics.currentPrice.toFixed(2)}<span class="metric-unit">¢/kWh</span></div>
                </div>
            `;
        }

        html += '</div>';
        return html;
    }

    createTagsSection(tags) {
        if (!tags || tags.length === 0) {
            return '';
        }

        let html = '<div class="notification-tags">';
        
        tags.forEach(tag => {
            const tagClass = this.getTagClass(tag);
            html += `<span class="notification-tag ${tagClass}">${this.getTagIcon(tag)} ${tag}</span>`;
        });

        html += '</div>';
        return html;
    }

    showToastNotification(notification) {
        if (notification.severity === 'info' && !this.settings.showInfoToasts) {
            return;
        }

        const toast = document.createElement('div');
        toast.className = `toast-notification ${notification.severity}`;
        
        toast.innerHTML = `
            <div class="toast-header">
                <div class="toast-title">${notification.title}</div>
                <button class="toast-close" onclick="this.parentElement.parentElement.remove()">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="toast-body">
                ${notification.message}
            </div>
        `;

        this.toastContainer.appendChild(toast);

        // Show toast
        setTimeout(() => {
            toast.classList.add('show');
        }, 100);

        // Auto-remove after delay
        const delay = notification.severity === 'critical' ? 10000 : 5000;
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => {
                if (toast.parentElement) {
                    toast.remove();
                }
            }, 300);
        }, delay);

        // Desktop notification
        if (this.settings.enableDesktop && 'Notification' in window && Notification.permission === 'granted') {
            new Notification(notification.title, {
                body: notification.message,
                icon: '/icon.png',
                tag: notification.id
            });
        }
    }

    async acknowledgeNotification(id) {
        try {
            const response = await fetch(`/api/notifications/${id}/acknowledge`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const notification = this.notifications.get(id);
                if (notification) {
                    notification.acknowledged = true;
                    this.renderNotifications();
                }
            }
        } catch (error) {
            console.error('Failed to acknowledge notification:', error);
        }
    }

    showDetails(id) {
        const notification = this.notifications.get(id);
        if (!notification) return;

        // Create modal with detailed information
        const modal = document.createElement('div');
        modal.className = 'notification-detail-modal';
        modal.innerHTML = `
            <div class="modal-overlay" onclick="this.parentElement.remove()"></div>
            <div class="modal-content">
                <div class="modal-header">
                    <h3>${notification.title}</h3>
                    <button class="modal-close" onclick="this.closest('.notification-detail-modal').remove()">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="modal-body">
                    <div class="detail-section">
                        <h4>Message</h4>
                        <p>${notification.message}</p>
                    </div>
                    <div class="detail-section">
                        <h4>Details</h4>
                        <div class="detail-grid">
                            <div class="detail-item">
                                <span class="detail-label">Severity:</span>
                                <span class="detail-value">${notification.severity}</span>
                            </div>
                            <div class="detail-item">
                                <span class="detail-label">Source:</span>
                                <span class="detail-value">${notification.source}</span>
                            </div>
                            <div class="detail-item">
                                <span class="detail-label">Type:</span>
                                <span class="detail-value">${notification.type}</span>
                            </div>
                            <div class="detail-item">
                                <span class="detail-label">Timestamp:</span>
                                <span class="detail-value">${new Date(notification.timestamp).toLocaleString()}</span>
                            </div>
                        </div>
                    </div>
                    ${notification.data ? `
                        <div class="detail-section">
                            <h4>System Data</h4>
                            <pre class="detail-json">${JSON.stringify(notification.data, null, 2)}</pre>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;

        document.body.appendChild(modal);
    }

    // Utility methods
    getFilteredNotifications() {
        let notifications = Array.from(this.notifications.values());

        // Apply filters
        if (this.filters.severity !== 'all') {
            notifications = notifications.filter(n => n.severity === this.filters.severity);
        }
        
        if (this.filters.type !== 'all') {
            notifications = notifications.filter(n => n.type === this.filters.type);
        }
        
        if (this.filters.source !== 'all') {
            notifications = notifications.filter(n => n.source === this.filters.source);
        }

        // Apply time range filter
        if (this.filters.timeRange !== 'all') {
            const now = new Date();
            const timeRanges = {
                '1h': 60 * 60 * 1000,
                '24h': 24 * 60 * 60 * 1000,
                '7d': 7 * 24 * 60 * 60 * 1000
            };
            
            const range = timeRanges[this.filters.timeRange];
            if (range) {
                const cutoff = new Date(now.getTime() - range);
                notifications = notifications.filter(n => new Date(n.timestamp) >= cutoff);
            }
        }

        // Sort by timestamp (newest first)
        notifications.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        return notifications.slice(0, this.settings.maxVisible);
    }

    groupNotificationsByKey(notifications) {
        const groups = new Map();
        
        notifications.forEach(notification => {
            const key = notification.groupKey || 'ungrouped';
            
            if (!groups.has(key)) {
                groups.set(key, {
                    key,
                    type: notification.type,
                    notifications: []
                });
            }
            
            groups.get(key).notifications.push(notification);
        });

        return Array.from(groups.values()).filter(group => group.notifications.length > 0);
    }

    getSeverityIcon(severity) {
        const icons = {
            info: '<i class="fas fa-info-circle"></i>',
            warning: '<i class="fas fa-exclamation-triangle"></i>',
            critical: '<i class="fas fa-exclamation-circle"></i>'
        };
        return icons[severity] || icons.info;
    }

    getSourceLabel(source) {
        const labels = {
            ai_engine: 'AI Charging Engine',
            battery_system: 'Battery System',
            grid_monitor: 'Grid Monitor',
            price_service: 'Price Service',
            system_monitor: 'System Monitor'
        };
        return labels[source] || source;
    }

    getTagClass(tag) {
        const classes = {
            ai_decision: 'tag-ai',
            battery: 'tag-battery',
            solar: 'tag-solar',
            grid: 'tag-grid',
            price: 'tag-price'
        };
        return classes[tag] || 'tag-default';
    }

    getTagIcon(tag) {
        const icons = {
            ai_decision: '🤖',
            battery: '🔋',
            solar: '☀️',
            grid: '⚡',
            price: '💰'
        };
        return icons[tag] || '🏷️';
    }

    getGroupTitle(group) {
        const titles = {
            ai_decision_ai_engine: 'AI Charging Decisions',
            battery_warning_battery_system: 'Battery Warnings',
            price_alert_price_service: 'Price Alerts',
            system_alert_grid_monitor: 'System Alerts'
        };
        return titles[group.key] || `${group.type} notifications`;
    }

    getTimeAgo(timestamp) {
        const now = new Date();
        const time = new Date(timestamp);
        const diff = now - time;

        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);

        if (days > 0) return `${days}d ago`;
        if (hours > 0) return `${hours}h ago`;
        if (minutes > 0) return `${minutes}m ago`;
        return 'Just now';
    }

    createEmptyState() {
        const element = document.createElement('div');
        element.className = 'notification-empty-state';
        element.innerHTML = `
            <div class="empty-icon">
                <i class="fas fa-bell-slash"></i>
            </div>
            <h3>No notifications</h3>
            <p>You're all caught up! New notifications will appear here.</p>
        `;
        return element;
    }

    playNotificationSound() {
        if (!this.soundEnabled) return;
        
        // Create audio element for notification sound
        const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBSuBzvLZiTYIG2m98OScTgwOUarm7blmGgU7k9n1unEiBC13yO/eizEIHWq+8+OWT');
        audio.volume = 0.3;
        audio.play().catch(() => {
            // Ignore errors if audio can't play
        });
    }

    requestNotificationPermission() {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission();
        }
    }

    loadSettings() {
        const saved = localStorage.getItem('carbonoz-notification-settings');
        if (saved) {
            this.settings = { ...this.settings, ...JSON.parse(saved) };
        }
    }

    saveSettings() {
        localStorage.setItem('carbonoz-notification-settings', JSON.stringify(this.settings));
    }

    setupEventListeners() {
        // Listen for settings changes
        document.addEventListener('notification-settings-changed', (e) => {
            this.settings = { ...this.settings, ...e.detail };
            this.saveSettings();
            this.renderNotifications();
        });
    }

    // Public API methods
    clearAll() {
        if (confirm('Are you sure you want to clear all notifications?')) {
            fetch('/api/notifications/clear', { method: 'POST' })
                .then(() => {
                    this.notifications.clear();
                    this.renderNotifications();
                })
                .catch(console.error);
        }
    }

    toggleSound() {
        this.soundEnabled = !this.soundEnabled;
        this.settings.enableSound = this.soundEnabled;
        this.saveSettings();
    }

    updateFilters(newFilters) {
        this.filters = { ...this.filters, ...newFilters };
        this.renderNotifications();
    }
}

// Initialize notification manager when DOM is ready
let notificationManager;
document.addEventListener('DOMContentLoaded', () => {
    notificationManager = new NotificationManager();
    
    // Make it globally available
    window.notificationManager = notificationManager;
});