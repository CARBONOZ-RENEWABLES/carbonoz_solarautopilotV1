/* Debug utilities for CARBONOZ SolarAutopilot */

// Debug function to check page status
window.debugPageStatus = function() {
    console.log('=== PAGE DEBUG STATUS ===');
    console.log('Current URL:', window.location.href);
    console.log('Document ready state:', document.readyState);
    
    const overlay = document.getElementById('loadingOverlay');
    console.log('Loading overlay exists:', !!overlay);
    if (overlay) {
        console.log('Loading overlay display:', overlay.style.display);
        console.log('Loading overlay classes:', overlay.className);
        console.log('Loading overlay visible:', overlay.offsetParent !== null);
    }
    
    console.log('Page content loaded:', !!document.getElementById('pageContent'));
    console.log('Scripts loaded:', document.scripts.length);
    console.log('=========================');
};

// Auto-run debug on page load
document.addEventListener('DOMContentLoaded', function() {
    setTimeout(() => {
        window.debugPageStatus();
    }, 1000);
});

// Check for JavaScript errors
window.addEventListener('error', function(e) {
    console.error('JavaScript Error:', e.error);
    console.error('File:', e.filename, 'Line:', e.lineno);
    
    // Force hide loading on error
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
        overlay.style.display = 'none';
        overlay.classList.remove('show');
        console.log('Loading overlay force hidden due to error');
    }
});