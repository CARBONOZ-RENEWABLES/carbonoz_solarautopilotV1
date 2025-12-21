/* CARBONOZ SolarAutopilot - Fixed Loading Functions */

// Show loading IMMEDIATELY - before DOM loads
(function() {
    // Create and inject loading overlay if it doesn't exist yet
    if (!document.getElementById('loadingOverlay')) {
        const overlay = document.createElement('div');
        overlay.id = 'loadingOverlay';
        overlay.className = 'loading-overlay show';
        overlay.style.display = 'flex';
        overlay.innerHTML = '<div class="loading-spinner"></div>';
        document.body.appendChild(overlay);
    } else {
        // Make sure existing overlay is visible
        const overlay = document.getElementById('loadingOverlay');
        overlay.style.display = 'flex';
        overlay.classList.add('show');
    }
})();

// Global loading functions
window.showLoading = function() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
        overlay.style.display = 'flex';
        overlay.classList.add('show');
    }
};

window.hideLoading = function() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
        overlay.classList.remove('show');
        setTimeout(() => {
            overlay.style.display = 'none';
        }, 300);
    }
};

// Wait for everything to load including iframes
document.addEventListener('DOMContentLoaded', function() {
    // Check if all iframes are loaded
    const iframes = document.querySelectorAll('iframe');
    let loadedCount = 0;
    const totalIframes = iframes.length;
    
    function checkAllLoaded() {
        loadedCount++;
        console.log(`Loaded ${loadedCount}/${totalIframes} iframes`);
        
        if (loadedCount >= totalIframes) {
            // All iframes loaded, wait a bit then hide loading
            setTimeout(() => {
                window.hideLoading();
            }, 1000);
        }
    }
    
    if (totalIframes === 0) {
        // No iframes, hide loading after DOM is ready
        setTimeout(() => {
            window.hideLoading();
        }, 1500);
    } else {
        // Add load listeners to all iframes
        iframes.forEach((iframe) => {
            if (iframe.complete) {
                checkAllLoaded();
            } else {
                iframe.addEventListener('load', checkAllLoaded);
                // Fallback: consider iframe loaded after 3 seconds even if event doesn't fire
                setTimeout(checkAllLoaded, 3000);
            }
        });
    }
});

// Secondary fallback: hide loading when window fully loads
window.addEventListener('load', function() {
    setTimeout(() => {
        console.log('Window load event: hiding loading');
        window.hideLoading();
    }, 2000);
});

// Emergency fallback - force hide after 8 seconds no matter what
setTimeout(() => {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay && overlay.classList.contains('show')) {
        console.log('Emergency fallback: force hiding loading overlay');
        window.hideLoading();
    }
}, 8000);
