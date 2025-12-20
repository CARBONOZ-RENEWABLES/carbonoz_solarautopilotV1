# AI-Powered Solar Charging System

## Overview

This AI system transforms your solar energy management into a fully autonomous charging optimizer that learns from historical patterns without requiring any weather APIs. The system uses advanced machine learning to predict solar generation, forecast household consumption, and optimize battery charging strategies.

## Key Features

### 🌞 Solar Generation Forecasting (NO Weather API Required)
- **Pattern-Based Learning**: Learns from historical PV power data stored in InfluxDB
- **Astronomical Calculations**: Uses sun position formulas for accurate predictions
- **Seasonal Adaptation**: Automatically detects and adapts to seasonal changes
- **Multi-Method Ensemble**: Combines multiple prediction approaches for accuracy
- **Confidence Scoring**: Provides uncertainty estimates for all predictions

**Prediction Features:**
- Time-based patterns (hour, day of week, month, season)
- Sun elevation angle calculations
- Historical average analysis (last 7 days, last month)
- Trend detection and variance analysis
- Cloudy vs sunny day pattern recognition

### ⚡ Load Forecasting
- **Consumption Patterns**: Learns household usage by time and day
- **Weekend vs Weekday**: Automatically detects different consumption patterns
- **Seasonal Changes**: Adapts to heating/cooling seasonal variations
- **Special Day Detection**: Identifies holidays and anomalous consumption
- **Recent Trend Analysis**: Incorporates recent usage changes

### 🧠 Intelligent Charging Strategy
- **Reinforcement Learning**: Deep Q-Network (DQN) that learns optimal decisions
- **Multi-Objective Optimization**: Balances cost savings, battery health, and self-consumption
- **Academic Research Based**: Implements findings showing 12.7% cost improvement
- **Dynamic Pricing Integration**: Uses Tibber API for real-time electricity prices
- **Battery Size Optimization**: Different strategies for different battery capacities

**Decision Factors:**
- Current electricity prices and forecasts
- Predicted solar generation (next 24-48 hours)
- Predicted household load
- Current battery state of charge (SOC)
- Battery capacity and health considerations
- Grid voltage constraints

### 🔍 Pattern Detection (Unsupervised Learning)
- **Daily Pattern Clustering**: Groups similar days using k-means clustering
- **Weather Pattern Inference**: Detects sunny/cloudy patterns from solar variance
- **Seasonal Transition Detection**: Identifies when seasons change
- **Anomaly Detection**: Flags unusual energy patterns
- **Automatic Classification**: Categorizes days as sunny, cloudy, mixed, or overcast

### 📊 Self-Learning System
- **Continuous Improvement**: Learns from actual outcomes vs predictions
- **Performance Tracking**: Monitors solar accuracy, load accuracy, cost savings
- **Adaptive Learning Rate**: Adjusts learning speed based on performance
- **Outcome Feedback**: Updates models based on actual results
- **30-90 Day Learning Period**: Reaches optimal performance after initial learning

## Academic Foundation

Based on research: *"Do dynamic electricity tariffs change the gains of residential PV-battery systems?"*

**Key Findings Implemented:**
- 12.7% cost improvement with dynamic tariffs for batteries ≤15 kWh
- Optimal charging threshold: ≤8¢/kWh
- Different strategies for different battery sizes:
  - **Small (≤15 kWh)**: Price-sensitive operation
  - **Medium (15-20 kWh)**: Hybrid strategy  
  - **Large (>20 kWh)**: Self-consumption maximization

**Technical Parameters:**
- Round-trip efficiency: 95% (charge) × 95% (discharge) = 90.25%
- SOC operating range: 20% minimum, 100% maximum, 80% target
- C-rate: 1.0 (full charge/discharge in 1 hour)
- Feed-in tariff consideration: ~8¢/kWh

## System Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Data Sources  │    │   AI Models      │    │   Decisions     │
├─────────────────┤    ├──────────────────┤    ├─────────────────┤
│ InfluxDB        │───▶│ Solar Predictor  │───▶│ Charge/Discharge│
│ - PV Power      │    │ Load Forecaster  │    │ Hold/Stop       │
│ - Load Data     │    │ Pattern Detector │    │ Current Control │
│ - Battery SOC   │    │ Charging Optimizer│    │ Mode Selection  │
│ - Price Data    │    └──────────────────┘    └─────────────────┘
│                 │              │                       │
│ Tibber API      │              ▼                       ▼
│ - Current Price │    ┌──────────────────┐    ┌─────────────────┐
│ - Price Forecast│    │ Reinforcement    │    │ MQTT Commands   │
│ - Price Levels  │    │ Learning Engine  │    │ - Inverter Ctrl │
└─────────────────┘    │ (DQN/Actor-Critic│    │ - Battery Mgmt  │
                       └──────────────────┘    └─────────────────┘
```

## Installation & Setup

### 1. Directory Structure
The AI system is organized as follows:
```
ai/
├── index.js                 # Main AI system coordinator
├── models/
│   ├── solarPredictor.js   # Solar generation forecasting
│   ├── loadForecaster.js   # Household load prediction
│   ├── chargingOptimizer.js # Reinforcement learning optimizer
│   └── patternDetector.js  # Unsupervised pattern detection
└── utils/
    └── dataProcessor.js    # Historical data processing
```

### 2. Dependencies
The system uses existing dependencies:
- `influx` - For historical data access
- `mqtt` - For inverter control
- Built-in Node.js modules for ML algorithms

### 3. Configuration
Configure through the existing web interface:
- **Tibber Integration**: Set API key for dynamic pricing
- **Battery Capacity**: System auto-detects or manual configuration
- **Location**: For sun position calculations (defaults to Berlin)

### 4. Data Requirements
**Minimum for Training:**
- 30 days of solar generation data
- 30 days of household load data
- Price data from Tibber API

**Optimal for Training:**
- 6-12 months of historical data
- Seasonal variation coverage
- Various weather condition data

## Usage

### Web Interface
Access the AI system through: `/ai-system`

**Dashboard Features:**
- Real-time AI status and confidence levels
- Model performance metrics (solar/load accuracy)
- 24-hour predictions visualization
- Training data quality assessment
- Detected pattern summary
- Manual controls (start/stop, retrain)

### API Endpoints

**Status & Control:**
- `GET /ai/status` - Current AI system status
- `POST /ai/toggle` - Enable/disable AI system
- `POST /ai/retrain` - Manually retrain models

**Predictions & Data:**
- `GET /ai/predictions` - Next 24-hour forecasts
- `GET /ai/performance` - Model accuracy metrics
- `GET /ai/data-quality` - Training data assessment

### Automatic Operation
Once configured, the system:
1. **Loads Historical Data** from InfluxDB (365 days)
2. **Trains Models** if sufficient data available
3. **Makes Predictions** every 5 minutes
4. **Optimizes Charging** based on predictions and prices
5. **Learns from Outcomes** continuously
6. **Adapts Strategies** based on performance

## Learning Process

### Phase 1: Initial Training (Day 1-7)
- Loads historical data from InfluxDB
- Trains solar predictor with seasonal patterns
- Builds load forecasting models
- Detects initial patterns
- Low confidence predictions (30-50%)

### Phase 2: Active Learning (Day 8-30)
- Compares predictions with actual outcomes
- Updates model weights based on errors
- Improves pattern recognition
- Increasing confidence (50-80%)

### Phase 3: Optimization (Day 31-90)
- Fine-tunes charging strategies
- Learns optimal timing patterns
- Maximizes cost savings
- High confidence predictions (80-95%)

### Phase 4: Maintenance (Day 90+)
- Continuous incremental learning
- Seasonal adaptation
- Performance monitoring
- Stable high performance

## Performance Metrics

### Solar Prediction Accuracy
- **Target**: >85% accuracy for next-day predictions
- **Measurement**: Mean Absolute Percentage Error (MAPE)
- **Factors**: Weather patterns, seasonal changes, system degradation

### Load Forecasting Accuracy  
- **Target**: >90% accuracy for household consumption
- **Measurement**: Root Mean Square Error (RMSE)
- **Factors**: Occupancy patterns, seasonal usage, appliance changes

### Cost Optimization
- **Target**: 12.7% improvement vs fixed tariffs (academic benchmark)
- **Measurement**: Monthly electricity cost comparison
- **Factors**: Price volatility, battery size, consumption patterns

### Self-Consumption Rate
- **Target**: Maximize use of self-generated solar power
- **Measurement**: (Solar used directly + Battery discharge) / Total consumption
- **Factors**: Load timing, battery capacity, solar generation

## Troubleshooting

### Common Issues

**1. Insufficient Training Data**
- **Symptom**: Low confidence predictions, poor performance
- **Solution**: Wait for more historical data, check InfluxDB connection
- **Minimum**: 30 days of data required

**2. Poor Solar Predictions**
- **Symptom**: High solar prediction errors
- **Solution**: Verify PV power data quality, check for sensor issues
- **Check**: Data completeness, outlier detection

**3. Inaccurate Load Forecasts**
- **Symptom**: Unexpected consumption patterns
- **Solution**: Review household changes, check for new appliances
- **Consider**: Seasonal adjustments, occupancy changes

**4. Suboptimal Charging Decisions**
- **Symptom**: Charging at high prices, missing cheap periods
- **Solution**: Verify Tibber price data, check battery SOC limits
- **Review**: Price thresholds, battery capacity settings

### Monitoring & Diagnostics

**Data Quality Checks:**
- Completeness: >80% data availability required
- Consistency: Check for sensor drift or calibration issues
- Recency: Ensure recent data is being collected

**Model Performance:**
- Track prediction accuracy over time
- Monitor learning curve progression
- Compare against baseline methods

**System Health:**
- InfluxDB connectivity and query performance
- MQTT command delivery success rate
- Tibber API response times and data freshness

## Advanced Configuration

### Custom Learning Parameters
```javascript
// Modify in chargingOptimizer.js
learningRate: 0.1,        // How fast the AI learns (0.01-0.3)
discountFactor: 0.95,     // Future reward importance (0.9-0.99)
explorationRate: 0.1,     // Exploration vs exploitation (0.05-0.2)
```

### Prediction Horizons
```javascript
// Modify in index.js
solarForecast: 48,        // Hours ahead for solar prediction
loadForecast: 48,         // Hours ahead for load prediction
priceHorizon: 24,         // Hours of price forecast used
```

### Battery Strategy Thresholds
```javascript
// Modify in aiChargingEngine.js
SMALL_BATTERY_THRESHOLD: 15,   // kWh - price-sensitive strategy
MEDIUM_BATTERY_THRESHOLD: 20,  // kWh - hybrid strategy
optimalChargeThreshold: 8,     // ¢/kWh - academic optimal
maxPriceThreshold: 10,         // ¢/kWh - never charge above
```

## Future Enhancements

### Planned Features
- **Multi-Battery Support**: Optimize multiple battery systems
- **EV Integration**: Include electric vehicle charging optimization
- **Grid Services**: Participate in demand response programs
- **Weather Integration**: Optional weather API for enhanced predictions
- **Machine Learning Upgrades**: Advanced neural networks (LSTM, Transformer)

### Research Areas
- **Federated Learning**: Learn from multiple installations
- **Predictive Maintenance**: Battery health optimization
- **Grid Interaction**: Two-way power flow optimization
- **Carbon Optimization**: Minimize carbon footprint vs cost

## Support & Documentation

### Getting Help
- **Web Interface**: Built-in diagnostics and status monitoring
- **Log Files**: Detailed logging for troubleshooting
- **API Documentation**: RESTful endpoints for integration
- **Performance Metrics**: Real-time accuracy and efficiency tracking

### Contributing
The AI system is designed to be modular and extensible:
- **Model Improvements**: Enhance prediction algorithms
- **New Features**: Add optimization objectives
- **Integration**: Connect with other home automation systems
- **Research**: Implement new academic findings

---

**Note**: This AI system operates entirely on historical patterns and does not require external weather APIs, making it privacy-friendly and reliable even with limited internet connectivity.