
    // Mobile Sidebar JavaScript
document.addEventListener('DOMContentLoaded', function() {
    const mobileToggle = document.getElementById('mobileToggle');
    const sidebar = document.getElementById('sidebar');
    const body = document.body;
    
    // Create overlay if it doesn't exist
    let overlay = document.querySelector('.sidebar-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'sidebar-overlay';
        document.body.appendChild(overlay);
    }

    function toggleSidebar() {
        mobileToggle.classList.toggle('active');
        sidebar.classList.toggle('active');
        overlay.classList.toggle('active');
        body.classList.toggle('sidebar-open');
    }

    // Toggle sidebar on button click
    mobileToggle.addEventListener('click', toggleSidebar);

    // Close sidebar when clicking overlay
    overlay.addEventListener('click', toggleSidebar);

    // Handle touch events
    let touchStartX = 0;
    let touchEndX = 0;

    document.addEventListener('touchstart', e => {
        touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    document.addEventListener('touchend', e => {
        touchEndX = e.changedTouches[0].screenX;
        handleSwipe();
    }, { passive: true });

    function handleSwipe() {
        const swipeThreshold = 50;
        const difference = touchEndX - touchStartX;

        if (Math.abs(difference) < swipeThreshold) return;

        if (difference > 0 && !sidebar.classList.contains('active')) {
            // Swipe right - open sidebar
            toggleSidebar();
        } else if (difference < 0 && sidebar.classList.contains('active')) {
            // Swipe left - close sidebar
            toggleSidebar();
        }
    }

    // Close sidebar on navigation
    const navLinks = sidebar.querySelectorAll('nav a');
    navLinks.forEach(link => {
        link.addEventListener('click', () => {
            if (window.innerWidth <= 768) {
                toggleSidebar();
            }
        });
    });
});
