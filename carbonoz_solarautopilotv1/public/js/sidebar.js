    // toggle sidebar
      
    const sidebar = document.getElementById('sidebar');
    const toggleSidebar = document.getElementById('toggleSidebar');
    const toggleSwitch = document.getElementById('toggleSwitch');
    
    toggleSidebar.addEventListener('click', () => {
      sidebar.classList.toggle('collapsed');
      toggleSwitch.classList.toggle('active');
    });