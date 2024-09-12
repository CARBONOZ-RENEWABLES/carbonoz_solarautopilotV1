
// Utility functions
async function fetchAPI(url, method = 'GET', body = null) {
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
        },
    };
    if (body) {
        options.body = JSON.stringify(body);
    }
    const response = await fetch(url, options);
    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
    }
    return response.json();
}

// Load and display universal settings
async function loadUniversalSettings() {
    const settings = await fetchAPI('<%= ingress_path %>/api/universal-settings');
    Object.entries(settings).forEach(([key, value]) => {
        const element = document.getElementById(key);
        if (element) {
            if (element.type === 'checkbox') {
                element.checked = value;
            } else {
                element.value = value;
            }
        }
    });
}

// Load inverter types and settings
async function loadInverterSettings() {
    const types = await fetchAPI('<%= ingress_path %>/api/inverter-types');
    const selectElement = document.getElementById('inverter-type');
    selectElement.innerHTML = types.map(type => `<option value="${type}">${type}</option>`).join('');
    
    const { type, settings } = await fetchAPI('<%= ingress_path %>/api/inverter-settings');
    selectElement.value = type;
    
    const workModeSelect = document.getElementById('workMode');
    workModeSelect.innerHTML = settings.workMode.map(mode => `<option value="${mode}">${mode}</option>`).join('');
    
    const energyPatternSelect = document.getElementById('energyPattern');
    energyPatternSelect.innerHTML = settings.energyPattern.map(pattern => `<option value="${pattern}">${pattern}</option>`).join('');
    
    document.getElementById('solarExportWhenBatteryFull').checked = settings.solarExportWhenBatteryFull;
    document.getElementById('maxSellPower').value = settings.maxSellPower;
}

// Load and display automation rules
async function loadAutomationRules() {
    const rules = await fetchAPI('<%= ingress_path %>/api/automation-rules');
    const tableBody = document.querySelector('#automation-rules-table tbody');
    tableBody.innerHTML = rules.map(rule => `
        <tr>
            <td>${rule.name}</td>
            <td>${JSON.stringify(rule.conditions)}</td>
            <td>${JSON.stringify(rule.actions)}</td>
            <td>${rule.days.join(', ')}</td>
            <td>
                <button onclick="editRule('${rule.id}')">Edit</button>
                <button onclick="deleteRule('${rule.id}')">Delete</button>
            </td>
        </tr>
    `).join('');
}

// Load and display scheduled settings
async function loadScheduledSettings() {
    const settings = await fetchAPI('<%= ingress_path %>/api/scheduled-settings');
    const tableBody = document.querySelector('#scheduled-settings-table tbody');
    tableBody.innerHTML = settings.map(setting => `
        <tr>
            <td>${setting.key}</td>
            <td>${setting.value}</td>
            <td>${setting.day}</td>
            <td>${setting.hour}</td>
            <td>
                <button onclick="editScheduledSetting('${setting.id}')">Edit</button>
                <button onclick="deleteScheduledSetting('${setting.id}')">Delete</button>
            </td>
        </tr>
    `).join('');
}

// Event listeners
document.getElementById('universal-settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const settings = Object.fromEntries(formData.entries());
    settings.gridChargeOn = formData.get('gridChargeOn') === 'on';
    settings.generatorChargeOn = formData.get('generatorChargeOn') === 'on';
    try {
        await fetchAPI('<%= ingress_path %>/api/universal-settings', 'POST', settings);
        alert('Universal settings updated successfully');
        // Send MQTT messages
        Object.entries(settings).forEach(([key, value]) => {
            sendMQTTMessage(`universal/${key}`, value);
        });
    } catch (error) {
        alert('Failed to update universal settings: ' + error.message);
    }
});

document.getElementById('inverter-settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const type = document.getElementById('inverter-type').value;
    const settings = {
        workMode: document.getElementById('workMode').value,
        solarExportWhenBatteryFull: document.getElementById('solarExportWhenBatteryFull').checked,
        energyPattern: document.getElementById('energyPattern').value,
        maxSellPower: parseInt(document.getElementById('maxSellPower').value)
    };
    try {
        await fetchAPI('<%= ingress_path %>/api/inverter-settings', 'POST', { type, settings });
        alert('Inverter settings updated successfully');
        // Send MQTT messages
        Object.entries(settings).forEach(([key, value]) => {
            sendMQTTMessage(`inverter/${key}`, value);
        });
    } catch (error) {
        alert('Failed to update inverter settings: ' + error.message);
    }
});

document.getElementById('add-inverter-btn').addEventListener('click', async () => {
    const newType = prompt('Enter new inverter type:');
    if (newType) {
        try {
            await fetchAPI('<%= ingress_path %>/api/inverter-types', 'POST', { type: newType, settings: {} });
            alert('New inverter type added: ' + newType);
            loadInverterSettings();
        } catch (error) {
            alert('Failed to add new inverter type: ' + error.message);
        }
    }
});

document.getElementById('delete-inverter-btn').addEventListener('click', async () => {
    const type = document.getElementById('inverter-type').value;
    if (confirm(`Are you sure you want to delete the inverter type: ${type}?`)) {
        try {
            await fetchAPI(`<%= ingress_path %>/api/inverter-types/${type}`, 'DELETE');
            alert('Inverter type deleted successfully');
            loadInverterSettings();
        } catch (error) {
            alert('Failed to delete inverter type: ' + error.message);
        }
    }
});

// Rule modal functionality
const ruleModal = document.getElementById('rule-modal');
const closeBtn = ruleModal.querySelector('.close');
let currentRuleId = null;

closeBtn.onclick = () => {
    ruleModal.style.display = 'none';
};

window.onclick = (event) => {
    if (event.target == ruleModal) {
        ruleModal.style.display = 'none';
    }
};

document.getElementById('add-rule-btn').addEventListener('click', () => {
    currentRuleId = null;
    document.getElementById('rule-name').value = '';
    document.getElementById('rule-conditions').value = '[]';
    document.getElementById('rule-actions').value = '[]';
    document.getElementById('rule-days').value = 'Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday';
    ruleModal.style.display = 'block';
});

document.getElementById('rule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const rule = {
        name: document.getElementById('rule-name').value,
        conditions: JSON.parse(document.getElementById('rule-conditions').value),
        actions: JSON.parse(document.getElementById('rule-actions').value),
        days: document.getElementById('rule-days').value.split(',').map(day => day.trim())
    };

    try {
        if (currentRuleId) {
            await fetchAPI(`<%= ingress_path %>/api/automation-rules/${currentRuleId}`, 'PUT', rule);
        } else {
            await fetchAPI('<%= ingress_path %>/api/automation-rules', 'POST', rule);
        }
        ruleModal.style.display = 'none';
        loadAutomationRules();
    } catch (error) {
        alert('Failed to save rule: ' + error.message);
    }
});

async function editRule(id) {
    currentRuleId = id;
    try {
        const rule = await fetchAPI(`<%= ingress_path %>/api/automation-rules/${id}`);
        document.getElementById('rule-name').value = rule.name;
        document.getElementById('rule-conditions').value = JSON.stringify(rule.conditions, null, 2);
        document.getElementById('rule-actions').value = JSON.stringify(rule.actions, null, 2);
        document.getElementById('rule-days').value = rule.days.join(',');
        ruleModal.style.display = 'block';
    } catch (error) {
        alert('Failed to load rule for editing: ' + error.message);
    }
}

async function deleteRule(id) {
    if (confirm('Are you sure you want to delete this rule?')) {
        try {
            await fetchAPI(`<%= ingress_path %>/api/automation-rules/${id}`, 'DELETE');
            loadAutomationRules();
        } catch (error) {
            alert('Failed to delete rule: ' + error.message);
        }
    }
}

document.getElementById('add-scheduled-setting-btn').addEventListener('click', () => {
    editScheduledSetting();
});

async function editScheduledSetting(id = null) {
    let setting = id ? await fetchAPI(`<%= ingress_path %>/api/scheduled-settings/${id}`) : {};
    const key = prompt('Enter setting key:', setting.key || '');
    const value = prompt('Enter setting value:', setting.value || '');
    const day = prompt('Enter day of week:', setting.day || '');
    const hour = prompt('Enter hour (0-23):', setting.hour || '');

    if (key && value && day && hour) {
        const updatedSetting = { key, value, day, hour: parseInt(hour) };
        try {
            if (id) {
                await fetchAPI(`<%= ingress_path %>/api/scheduled-settings/${id}`, 'PUT', updatedSetting);
            } else {
                await fetchAPI('<%= ingress_path %>/api/scheduled-settings', 'POST', updatedSetting);
            }
            loadScheduledSettings();
        } catch (error) {
            alert('Failed to save scheduled setting: ' + error.message);
        }
    }
}

async function deleteScheduledSetting(id) {
    if (confirm('Are you sure you want to delete this scheduled setting?')) {
        try {
            await fetchAPI(`<%= ingress_path %>/api/scheduled-settings/${id}`, 'DELETE');
            loadScheduledSettings();
        } catch (error) {
            alert('Failed to delete scheduled setting: ' + error.message);
        }
    }
}

function addToAutomationLog(message) {
    const logElement = document.getElementById('automation-log');
    const logEntry = document.createElement('p');
    logEntry.textContent = `${new Date().toLocaleString()}: ${message}`;
    logElement.prepend(logEntry);

    // Keep only the last 50 log entries
    while (logElement.children.length > 50) {
        logElement.removeChild(logElement.lastChild);
    }
}

async function sendMQTTMessage(topic, value) {
    try {
        await fetchAPI('<%= ingress_path %>/api/mqtt', 'POST', { topic: `solar_assistant_DEYE/${topic}`, message: value });
        addToAutomationLog(`Sent MQTT message: ${topic} = ${value}`);
    } catch (error) {
        console.error('Failed to send MQTT message:', error);
        addToAutomationLog(`Failed to send MQTT message: ${topic} = ${value}`);
    }
}

function updateSystemState(state) {
    const stateElement = document.getElementById('system-state');
    stateElement.innerHTML = `
        <p>Battery Power: ${state.batteryPower} W</p>
        <p>Battery SOC: ${state.batterySOC}%</p>
        <p>Solar Power: ${state.solarPower} W</p>
        <p>Grid Power: ${state.gridPower} W</p>
        <p>Load Power: ${state.loadPower} W</p>
        <p>Last Updated: ${new Date(state.time).toLocaleString()}</p>
    `;
}

function handleRealtimeUpdate(update) {
    if (update.type === 'automationRuleTriggered') {
        addToAutomationLog(`Automation rule triggered: ${update.ruleName}`);
        update.actions.forEach(action => {
            sendMQTTMessage(`${action.key}`, action.value);
        });
    } else if (update.type === 'scheduledSettingApplied') {
        addToAutomationLog(`Scheduled setting applied: ${update.key} = ${update.value}`);
        sendMQTTMessage(`${update.key}`, update.value);
    }
}

// Initialize the page
window.addEventListener('load', () => {
    loadUniversalSettings();
    loadInverterSettings();
    loadAutomationRules();
    loadScheduledSettings();

    // Set up a WebSocket connection to receive real-time updates
    const socket = new WebSocket(`ws://${window.location.host}`);
    socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'automationLog') {
            addToAutomationLog(data.message);
        } else if (data.type === 'stateUpdate') {
            updateSystemState(data.state);
        } else if (data.type === 'realtimeUpdate') {
            handleRealtimeUpdate(data);
        }
    };
});


  


// <![CDATA[  <-- For SVG support
if ('WebSocket' in window) {
    (function () {
        function refreshCSS() {
            var sheets = [].slice.call(document.getElementsByTagName("link"));
            var head = document.getElementsByTagName("head")[0];
            for (var i = 0; i < sheets.length; ++i) {
                var elem = sheets[i];
                var parent = elem.parentElement || head;
                parent.removeChild(elem);
                var rel = elem.rel;
                if (elem.href && typeof rel != "string" || rel.length == 0 || rel.toLowerCase() == "stylesheet") {
                    var url = elem.href.replace(/(&|\?)_cacheOverride=\d+/, '');
                    elem.href = url + (url.indexOf('?') >= 0 ? '&' : '?') + '_cacheOverride=' + (new Date().valueOf());
                }
                parent.appendChild(elem);
            }
        }
        var protocol = window.location.protocol === 'http:' ? 'ws://' : 'wss://';
        var address = protocol + window.location.host + window.location.pathname + '/ws';
        var socket = new WebSocket(address);
        socket.onmessage = function (msg) {
            if (msg.data == 'reload') window.location.reload();
            else if (msg.data == 'refreshcss') refreshCSS();
        };
        if (sessionStorage && !sessionStorage.getItem('IsThisFirstTime_Log_From_LiveServer')) {
            console.log('Live reload enabled.');
            sessionStorage.setItem('IsThisFirstTime_Log_From_LiveServer', true);
        }
    })();
}
else {
    console.error('Upgrade your browser. This Browser is NOT supported WebSocket for Live-Reloading.');
}
// ]]>