document.addEventListener('DOMContentLoaded', () => {
    // Function to get data from table
    function getTableData(tableId) {
        const rows = document.querySelectorAll(`#${tableId} tbody tr`);
        let labels = [];
        let loadData = [];
        let solarData = [];
        let gridUsedData = [];
        let gridExportedData = [];
  
        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            labels.push(cells[0].textContent.trim());
            loadData.push(parseFloat(cells[1].textContent));
            solarData.push(parseFloat(cells[2].textContent));
            gridUsedData.push(parseFloat(cells[5].textContent));
            gridExportedData.push(parseFloat(cells[6].textContent));
        });
  
        return { labels, loadData, solarData, gridUsedData, gridExportedData };
    }
  
    // Function to update chart
    function updateChart(chartElementId, labels, datasets) {
        const ctx = document.getElementById(chartElementId).getContext('2d');
        new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: datasets
            },
            options: {
                responsive: true,
                scales: {
                    x: { stacked: true },
                    y: {
                        stacked: true,
                        title: { display: true, text: 'kWh' }
                    }
                },
                plugins: {
                    legend: { position: 'top' },
                    title: { display: true, text: chartElementId.replace(/-/g, ' ') }
                }
            }
        });
    }
  
    // Function to calculate Solar PV totals
    function calculateSolarPVTotals(data) {
        let dailyTotal = data.solarData[data.solarData.length - 1] || 0;
        let weeklyTotal = data.solarData.slice(-7).reduce((sum, value) => sum + value, 0);
        let monthlyTotal = data.solarData.reduce((sum, value) => sum + value, 0);
  
        return { dailyTotal, weeklyTotal, monthlyTotal };
    }
  
    // CSV generation function
    function generateCSV(tableId) {
        let csv = [];
        const rows = document.querySelectorAll(`#${tableId} tr`);
    
        rows.forEach(row => {
            let rowData = [];
            const cells = row.querySelectorAll('th, td');
            cells.forEach(cell => {
                // Remove 'kWh' from the cell content and trim any whitespace
                let cellContent = cell.textContent.replace('kWh', '').trim();
                rowData.push(cellContent);
            });
            csv.push(rowData.join(','));
        });
    
        const blob = new Blob([csv.join('\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
    
        const downloadLink = document.getElementById(`${tableId}-download`);
        downloadLink.href = url;
        downloadLink.download = `${tableId}-${new Date().toISOString()}.csv`;
    }
  
    // Get data for last 30 days
    const last30DaysData = getTableData('last30days-table');
  
    // Update last 30 days chart
    updateChart('last-30-days-chart', last30DaysData.labels.reverse(), [
        { label: 'Load', data: last30DaysData.loadData.reverse(), backgroundColor: '#FF5722' },
        { label: 'Solar PV', data: last30DaysData.solarData.reverse(), backgroundColor: '#FFA500' },
        { label: 'Grid Used', data: last30DaysData.gridUsedData.reverse(), backgroundColor: '#9C27B0' },
        { label: 'Grid Exported', data: last30DaysData.gridExportedData.reverse(), backgroundColor: '#607D8B' }
    ]);
  
    // Get data for last 12 months
    const last12MonthsData = getTableData('last12months-table');
  
    // Update last 12 months chart
    updateChart('last-12-months-chart', last12MonthsData.labels.reverse(), [
        { label: 'Load', data: last12MonthsData.loadData.reverse(), backgroundColor: '#FF5722' },
        { label: 'Solar PV', data: last12MonthsData.solarData.reverse(), backgroundColor: '#FFA500' },
        { label: 'Grid Used', data: last12MonthsData.gridUsedData.reverse(), backgroundColor: '#9C27B0' },
        { label: 'Grid Exported', data: last12MonthsData.gridExportedData.reverse(), backgroundColor: '#607D8B' }
    ]);
  
    // Get data for yearly chart
    const yearlyData = getTableData('yearly-table');
  
    // Update yearly chart
    updateChart('yearly-chart', yearlyData.labels, [
        { label: 'Load', data: yearlyData.loadData, backgroundColor: '#FF5722' },
        { label: 'Solar PV', data: yearlyData.solarData, backgroundColor: '#FFA500' },
        { label: 'Grid Used', data: yearlyData.gridUsedData, backgroundColor: '#9C27B0' },
        { label: 'Grid Exported', data: yearlyData.gridExportedData, backgroundColor: '#607D8B' }
    ]);
  
    // Calculate and display Solar PV totals
    const solarPVTotals = calculateSolarPVTotals(last30DaysData);
    document.getElementById('daily-solar-pv-total').textContent = `${solarPVTotals.dailyTotal.toFixed(1)} kWh`;
    document.getElementById('weekly-solar-pv-total').textContent = `${solarPVTotals.weeklyTotal.toFixed(1)} kWh`;
    document.getElementById('monthly-solar-pv-total').textContent = `${solarPVTotals.monthlyTotal.toFixed(1)} kWh`;
  
    // Generate CSV for all tables
    generateCSV('last30days-table');
    generateCSV('last12months-table');
    generateCSV('yearly-table');
  
    // Function to get battery data from table
    function getBatteryData(tableId) {
        const rows = document.querySelectorAll(`#${tableId} tbody tr`);
        let labels = [];
        let batteryChargedData = [];
        let batteryDischargedData = [];
  
        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            labels.push(cells[0].textContent.trim());
            batteryChargedData.push(parseFloat(cells[3].textContent));
            batteryDischargedData.push(parseFloat(cells[4].textContent));
        });
  
        return { labels: labels.reverse(), batteryChargedData: batteryChargedData.reverse(), batteryDischargedData: batteryDischargedData.reverse() };
    }
  
    // Function to create battery chart
    function createBatteryChart(chartElementId, data) {
        const ctx = document.getElementById(chartElementId).getContext('2d');
        new Chart(ctx, {
            type: 'bar',
            data: {
                labels: data.labels,
                datasets: [
                    {
                        label: 'Battery Charged',
                        data: data.batteryChargedData.map(value => -value),
                        backgroundColor: '#FF8DA1',
                        stack: 'battery'
                    },
                    {
                        label: 'Battery Discharged',
                        data: data.batteryDischargedData,
                        backgroundColor: '#0C7085',
                        stack: 'battery'
                    }
                ]
            },
            options: {
                responsive: true,
                scales: {
                    x: { stacked: true },
                    y: {
                        stacked: true,
                        title: { display: true, text: 'kWh' }
                    }
                },
                plugins: {
                    legend: { position: 'top' },
                    title: { 
                        display: true, 
                        text: 'Battery Charge/Discharge - Last 30 Days',
                        font: { size: 16 }
                    }
                }
            }
        });
    }
  
    // Create battery chart
    const batteryData = getBatteryData('last30days-table');
    createBatteryChart('battery-chart', batteryData);
  
    // Sidebar toggle functionality
    const sidebar = document.getElementById('sidebar');
    const toggleSidebar = document.getElementById('toggleSidebar');
    const toggleSwitch = document.getElementById('toggleSwitch');
  
    toggleSidebar.addEventListener('click', () => {
        sidebar.classList.toggle('collapsed');
        toggleSwitch.classList.toggle('active');
    });
  
    // Hide loading overlay
    const loadingOverlay = document.getElementById('loadingOverlay');
    loadingOverlay.style.display = 'none';
  });