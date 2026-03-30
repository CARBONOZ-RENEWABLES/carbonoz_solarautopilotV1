// Use EXISTING WebSocket connection to send AI charging data
// This integrates with your existing MQTT WebSocket connection

function sendAiChargingUpdate(ws, userId, aiChargingEngine, currentSystemState, tibberService) {
  if (!ws || ws.readyState !== 1) return; // 1 = OPEN
  if (!aiChargingEngine.enabled) return;

  const status = aiChargingEngine.getStatus();
  const lastDecision = status.lastDecision;

  const chargingData = {
    type: 'ai-charging',
    userId: userId,
    status: aiChargingEngine.enabled ? 'active' : 'standby',
    mode: lastDecision?.decision?.includes('CHARGE') ? 'charging' : 'monitoring',
    batteryLevel: currentSystemState.battery_soc || 0,
    targetSOC: tibberService.config?.targetSoC || 80,
    lastCommandTime: lastDecision?.timestamp || null,
    lastCommandReason: lastDecision?.decision || 'No recent commands'
  };

  ws.send(JSON.stringify(chargingData));
}

module.exports = { sendAiChargingUpdate };
