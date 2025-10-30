# AI Charging Commands by Inverter Type

## Overview
The CARBONOZ SolarAutopilot AI Charging Engine automatically sends commands to control battery charging based on electricity prices, battery state, and solar production. Different inverter types require different command formats.

## Inverter Types

### 1. Legacy Inverters
**Type:** `legacy`
**Command Parameter:** `grid_charge`

#### Enable Charging Command
```
Topic: solar/inverter_1/grid_charge/set
Value: "Enabled"
```

#### Disable Charging Command
```
Topic: solar/inverter_1/grid_charge/set
Value: "Disabled"
```

**Meaning:**
- `Enabled`: Allows battery charging from grid electricity
- `Disabled`: Prevents grid charging, only solar charging allowed

---

### 2. Modern/New Inverters
**Type:** `new`
**Command Parameter:** `charger_source_priority`

#### Intelligent Dynamic Mode Selection
```
Topic: solar/inverter_1/charger_source_priority/set
Value: [Dynamically Selected Based on Conditions]
```

**Two Control Parameters:**

1. **Charger Source Priority** (Controls battery charging):
   - `Solar first` - Solar priority for charging
   - `Solar and utility simultaneously` - Both sources charge battery
   - `Solar only` - Exclusive solar charging
   - `Utility first` - Grid priority for charging

2. **Output Source Priority** (Controls power output to loads):
   - `Solar/Battery/Utility` - Solar → Battery → Grid sequence
   - `Solar first` - Solar priority for loads
   - `Utility first` - Grid priority for loads
   - `Solar/Utility/Battery` - Solar → Grid → Battery sequence

**Dynamic Selection Logic:**

| Condition | Charger Priority | Output Priority | Explanation |
|-----------|------------------|-----------------|-------------|
| No PV, price low | `Utility first` | `Utility first` | Cheap grid energy |
| No PV, price high | `Solar first` | `Solar/Battery/Utility` | Avoid expensive grid |
| PV available & price low | `Solar and utility simultaneously` | `Solar/Utility/Battery` | Fast charging |
| PV > Load × 2 & SOC < 90% | `Solar only` | `Solar first` | Strong solar surplus |
| PV moderate & SOC < 50% | `Solar and utility simultaneously` | `Solar/Utility/Battery` | Mixed charging |
| SOC > target or grid unstable | `Solar first` | `Solar/Battery/Utility` | Safety mode |

---

### 3. Hybrid Inverters
**Type:** `hybrid`
**Supports both command types with intelligent mapping**

The AI engine automatically detects the inverter type and uses the appropriate command:

#### For Legacy Mode
```
Topic: solar/inverter_1/grid_charge/set
Value: "Enabled" / "Disabled"
```

#### For Modern Mode
```
Topic: solar/inverter_1/charger_source_priority/set
Value: "Utility first" / "Solar first"
```

---

## Enhanced AI Decision Logic

### Intelligent Mode Selection Process

**Priority Order:**
1. **Safety First:** SOC > target or grid unstable → `Solar first`
2. **Strong Solar:** PV > Load × 2 & SOC < 90% → `Solar only`
3. **No PV Scenarios:**
   - Price low → `Utility first`
   - Price high → `Solar/Battery/Utility`
4. **PV Available Scenarios:**
   - Price low → `Solar and utility simultaneously`
   - SOC < 50% → `Solar/Utility/Battery`
5. **Default:** `Solar first`

**Example Decision Logs:**

```json
{
  "decision": "START_CHARGING",
  "mode": "Solar and utility simultaneously",
  "reason": "PV + cheap grid",
  "conditions": {
    "pv_power": 1500,
    "load": 800,
    "price_level": "CHEAP",
    "battery_soc": 45
  }
}
```

```json
{
  "decision": "START_CHARGING", 
  "mode": "Solar only",
  "reason": "Strong solar surplus",
  "conditions": {
    "pv_power": 3000,
    "load": 1200,
    "battery_soc": 65
  }
}
```

---

## Command Mapping Examples

### Legacy Inverter Example
```javascript
// AI Decision: Enable charging
const topic = "solar/inverter_1/grid_charge/set";
const value = "Enabled";

// Result: Battery charges from grid when solar insufficient
```

### Modern Inverter Example
```javascript
// AI Decision: Intelligent settings selection
const settings = getOptimalChargingSettings(true);

// Send both commands
const chargerTopic = "solar/inverter_1/charger_source_priority/set";
const outputTopic = "solar/inverter_1/output_source_priority/set";

publish(chargerTopic, settings.chargerPriority);  // e.g., "Solar and utility simultaneously"
publish(outputTopic, settings.outputPriority);    // e.g., "Solar/Utility/Battery"

// Console: "🧠 Charger='Solar and utility simultaneously', Output='Solar/Utility/Battery' (PV + cheap grid)"
```

### Intelligent Mode Selection for Modern Inverters
```javascript
// Dynamic mode selection based on real-time conditions
const optimalMode = getOptimalChargingMode(enableCharging);

// Example conditions and resulting modes:
if (noPV && priceLow) {
  mode = 'Utility first';  // Cheap grid energy
} else if (strongSolar && socLow) {
  mode = 'Solar only';     // Abundant solar power
} else if (pvAvailable && priceLow) {
  mode = 'Solar and utility simultaneously';  // Fast charging
}
```

---

## Multiple Inverter Support

For systems with multiple inverters:

```javascript
// Commands sent to all inverters
for (let i = 1; i <= numInverters; i++) {
  const topic = `solar/inverter_${i}/grid_charge/set`;
  const value = "Enabled";
  
  // Publish command to each inverter
}
```

---

## Safety Features

### Learner Mode Protection
- Commands only sent when Learner Mode is ACTIVE
- Prevents accidental commands during testing

### Grid Voltage Monitoring
```javascript
if (gridVoltage < 200 || gridVoltage > 250) {
  decision = 'STOP_CHARGING';
  reasons.push(`Grid voltage unstable: ${gridVoltage}V`);
}
```

### Battery Protection
```javascript
if (batterySOC >= targetSoC) {
  decision = 'STOP_CHARGING';
  reasons.push(`Battery SOC at target: ${batterySOC}%`);
}
```

---

## Command History Logging

All commands are logged with:
- Timestamp
- MQTT topic
- Command value
- Success/failure status
- Source (AI_ENGINE)

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "topic": "solar/inverter_1/grid_charge/set",
  "value": "Enabled",
  "success": true,
  "source": "AI_ENGINE"
}
```

---

## Tibber Integration

The AI uses Tibber electricity prices to make intelligent charging decisions:

### Price Levels
- `VERY_CHEAP` - Aggressive charging recommended
- `CHEAP` - Charging recommended
- `NORMAL` - Conditional charging
- `EXPENSIVE` - Avoid charging
- `VERY_EXPENSIVE` - Stop charging immediately

### Condition-Based Mode Selection
```javascript
// Real-time intelligent mode selection
const conditions = {
  pvPower: 2000,
  load: 800, 
  batterySOC: 45,
  priceLevel: 'CHEAP',
  gridVoltage: 235
};

if (conditions.pvPower > conditions.load * 2 && conditions.batterySOC < 90) {
  mode = 'Solar only';  // Strong solar surplus
} else if (!pvAvailable && conditions.priceLevel === 'CHEAP') {
  mode = 'Utility first';  // No PV, cheap grid
}

publishCommand(topic, mode);
```

---

## Monitoring and Debugging

### Real-time Status
- AI engine status (enabled/disabled)
- Last decision and timestamp
- Decision count
- Current system state

### Command Verification
- MQTT publish confirmation
- Command success/failure tracking
- Auto-retry on failures

### Historical Analysis
- Decision pattern learning
- Price correlation analysis
- System performance optimization