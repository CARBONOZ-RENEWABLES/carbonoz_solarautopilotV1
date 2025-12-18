/* CARBONOZ SolarAutopilot - Shared Loading Functions */

// Global loading functions (fallback if not defined in page)
if (typeof showLoading === 'undefined') {
    window.showLoading = function() {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) {
            overlay.style.display = 'flex';
            overlay.classList.add('show');
        }
    };
}

if (typeof hideLoading === 'undefined') {
    window.hideLoading = function() {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) {
            overlay.classList.remove('show');
            setTimeout(() => {
                overlay.style.display = 'none';
            }, 300);
        }
    };
}

// Auto-initialize loading on page load
document.addEventListener('DOMContentLoaded', function() {
    // Show loading immediately
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
        overlay.style.display = 'flex';
        overlay.classList.add('show');
    }
    
    // Fallback: hide loading after a reasonable time if page doesn't handle it
    setTimeout(() => {
        if (overlay && overlay.classList.contains('show')) {
            console.log('Fallback: hiding loading overlay after 3 seconds');
            window.hideLoading();
        }
    }, 3000);
    
    // Emergency fallback - force hide after 8 seconds no matter what
    setTimeout(() => {
        if (overlay) {
            console.log('Emergency fallback: force hiding loading overlay');
            overlay.style.display = 'none';
            overlay.classList.remove('show');
        }
    }, 8000);
});

// Also hide loading when page is fully loaded
window.addEventListener('load', function() {
    setTimeout(() => {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay && overlay.classList.contains('show')) {
            console.log('Window load: hiding loading overlay');
            window.hideLoading();
        }
    }, 1000);
});