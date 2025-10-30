# Home Assistant Validation Fixes

## Problem
Getting "The string did not match the expected pattern" errors when creating/editing rules in Home Assistant, but it works fine outside of Home Assistant.

## Root Cause
Home Assistant has stricter JSON validation and pattern matching requirements compared to standalone environments. The errors are caused by:

1. **Invalid characters in rule names** - Special characters that Home Assistant doesn't accept
2. **Improper data types** - Sending strings when numbers are expected
3. **Missing field validation** - Required fields not properly validated
4. **JSON structure issues** - Malformed JSON or unexpected field types

## Fixes Applied

### 1. Server-Side Validation (`server.js`)

Added `validateAndSanitizeRuleData()` function that:
- **Sanitizes rule names**: Removes special characters, only allows alphanumeric, spaces, hyphens, underscores
- **Validates field types**: Ensures proper data types for all fields
- **Validates enums**: Only allows known values for settings and parameters
- **Validates time format**: Ensures HH:MM format for time restrictions
- **Validates arrays**: Ensures conditions and actions are proper arrays

### 2. Client-Side Validation (`wizard.ejs`)

Enhanced validation includes:
- **Rule name validation**: Character limits and allowed characters
- **Field completion checks**: All required fields must be filled
- **Data type validation**: Numbers must be valid numbers
- **Time format validation**: HH:MM pattern matching
- **Action completeness**: All action fields must be complete

### 3. Enhanced Error Handling

- **Better error messages**: More specific error descriptions
- **Response validation**: Proper JSON parsing with fallbacks
- **Debug logging**: Detailed logging for troubleshooting

## Key Changes Made

### Rule Name Sanitization
```javascript
// Only allow safe characters
sanitized.name = sanitized.name.replace(/[^a-zA-Z0-9\s\-_]/g, '');
```

### Condition Validation
```javascript
// Ensure numeric values
value: parseFloat(condition.value) || 0
```

### Time Format Validation
```javascript
// Strict HH:MM pattern
const timePattern = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
```

### Setting Validation
```javascript
// Only allow known settings
const validSettings = [
  'grid_charge', 'energy_pattern', 'charger_source_priority', 
  'output_source_priority', 'max_discharge_current', 'max_charge_current',
  // ... other valid settings
];
```

## Testing the Fixes

1. **Create a new rule** with various characters in the name
2. **Edit an existing rule** to ensure updates work
3. **Test time restrictions** with different time formats
4. **Test conditions** with various numeric values
5. **Test actions** with different settings and values

## Files Modified

1. `server.js` - Added validation function and updated POST/PUT endpoints
2. `views/wizard.ejs` - Enhanced client-side validation
3. `fix-validation.js` - Standalone validation utilities (optional)

## Expected Results

After applying these fixes:
- ✅ Rules should create successfully in Home Assistant
- ✅ Rule editing should work without pattern errors
- ✅ Better error messages when validation fails
- ✅ Consistent behavior between Home Assistant and standalone modes

## Additional Recommendations

1. **Test thoroughly** in Home Assistant environment
2. **Monitor logs** for any remaining validation issues
3. **Consider adding** more specific field validations as needed
4. **Update documentation** to reflect character restrictions for rule names