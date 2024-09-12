
// Toggle dark mode
const toggleDarkMode = document.getElementById('toggleDarkMode');
const darkModeSwitch = document.getElementById('darkModeSwitch');

// Function to update Grafana iframes based on dark mode
function updateGrafanaIframes(isDarkMode) {
    const iframes = document.querySelectorAll('iframe');
    iframes.forEach(iframe => {
        let src = iframe.src;

        // Remove any existing theme parameter to avoid multiple occurrences
        src = src.replace(/([?&]theme=)(light|dark)/, '');

        // Add the new theme parameter based on dark mode setting
        const separator = src.includes('?') ? '&' : '?';
        src = `${src}${separator}theme=${isDarkMode ? 'dark' : 'light'}`;

        // Only reload iframe if theme has changed
        if (iframe.src !== src) {
            iframe.src = src;
        }
    });
}

// Function to apply the mode (either from localStorage or default)
function applyModeFromLocalStorage() {
    const isDarkMode = localStorage.getItem('dark-mode') === 'enabled';

    if (isDarkMode) {
        document.body.classList.add('dark-mode');
        darkModeSwitch.classList.add('active');
    } else {
        document.body.classList.remove('dark-mode');
        darkModeSwitch.classList.remove('active');
    }

    // Update Grafana dashboards to match the saved mode
    updateGrafanaIframes(isDarkMode);
}

// Add click event listener for dark mode toggle
toggleDarkMode.addEventListener('click', () => {
    const isDarkMode = document.body.classList.toggle('dark-mode');
    darkModeSwitch.classList.toggle('active');

    // Update Grafana dashboards to match the dark mode setting
    updateGrafanaIframes(isDarkMode);

    // Save the dark mode state in localStorage
    if (isDarkMode) {
        localStorage.setItem('dark-mode', 'enabled');
    } else {
        localStorage.setItem('dark-mode', 'disabled');
    }
});

// Check and apply the user's dark mode preference on page load and when navigating back
document.addEventListener('DOMContentLoaded', () => {
    applyModeFromLocalStorage();
});

// Apply mode on `pageshow` event (works when navigating back in browser history)
window.addEventListener('pageshow', () => {
    applyModeFromLocalStorage();
});


