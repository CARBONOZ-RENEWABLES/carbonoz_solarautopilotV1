   // loading js
        
   document.addEventListener('DOMContentLoaded', function() {
    const loadingOverlay = document.getElementById('loadingOverlay');
    const pageContent = document.getElementById('pageContent');
  
    // Simulate loading time (you can adjust this as needed)
    setTimeout(() => {
      loadingOverlay.style.display = 'none';
      pageContent.style.display = 'block';
      // Trigger a custom event to signal that the page is ready
      document.dispatchEvent(new Event('pageReady'));
    }, 1500); // 1.5 seconds loading time
  });