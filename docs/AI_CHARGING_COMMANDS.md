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

#### Enable Charging Command
```
Topic: solar/inverter_1/charger_source_priority/set
Value: "Utility first"
```

#### Disable Charging Command
```
Topic: solar/inverter_1/charger_source_priority/set
Value: "Solar first"
```

**Available Options:**
- `Solar first` - Charges from solar only, no grid charging
- `Solar and utility simultaneously` - Charges from both solar and grid
- `Solar only` - Solar charging exclusively
- `Utility first` - Prioritizes grid charging over solar

**Meaning:**
- When AI enables charging: Prioritizes grid charging over solar for maximum speed
- When AI disables charging: Uses only solar power, no grid consumption

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

## AI Decision Logic

### When AI Enables Charging (`START_CHARGING`)

**Conditions:**
- Battery SOC below target (e.g., < 80%)
- Electricity price is good (below average or marked as CHEAP/VERY_CHEAP)
- Grid voltage is stable (200-250V)
- PV surplus available OR price-based opportunity

**Example Decision Log:**
```json
{
  "decision": "START_CHARGING",
  "reasons": [
    "Good price: 0.15 EUR (avg: 0.22, level: VERY_CHEAP)",
    "Battery SOC below target: 45%"
  ],
  "systemState": {
    "battery_soc": 45,
    "pv_power": 1200,
    "grid_voltage": 230
  }
}
```

### When AI Disables Charging (`STOP_CHARGING`)

**Conditions:**
- Battery SOC at target (e.g., ≥ 80%)
- Price too high (> 20% above average)
- Grid voltage unstable
- Sufficient PV power available

**Example Decision Log:**
```json
{
  "decision": "STOP_CHARGING",
  "reasons": [
    "Battery SOC at target: 80%",
    "Price too high: 0.35 EUR (20% above avg: 0.22)"
  ],
  "systemState": {
    "battery_soc": 80,
    "pv_power": 2500,
    "grid_voltage": 235
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
// AI Decision: Enable charging
const topic = "solar/inverter_1/charger_source_priority/set";
const value = "Utility first";

// Result: Battery charges primarily from grid for faster charging
```

### Auto-Mapping for Compatibility
```javascript
// Input: grid_charge "Enabled"
// Auto-mapped to: charger_source_priority "Utility first"

const mapping = {
  'Enabled': 'Utility first',
  'Disabled': 'Solar first'
};
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

### Price-Based Commands
```javascript
if (priceLevel === 'VERY_CHEAP' && batterySOC < targetSoC) {
  // Send enable charging command
  publishCommand(topic, 'Enabled');
}
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