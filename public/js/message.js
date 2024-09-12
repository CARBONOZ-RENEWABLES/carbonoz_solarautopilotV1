   
 
    const messageList = document.getElementById('messageList');
    const categoryFilter = document.getElementById('categoryFilter');
    const refreshButton = document.getElementById('refreshButton');
    const ingressPath = '<%= ingress_path %>';
    
    function fetchMessages() {
        const category = categoryFilter.value;
        fetch(`${ingressPath}/api/messages?category=${category}`)
            .then(response => response.json())
            .then(messages => {
                messageList.innerHTML = '';
                messages.forEach(message => {
                    const [topic, value] = message.split(': ');
                    const messageElement = document.createElement('div');
                    messageElement.className = 'message';
                    messageElement.innerHTML = `
                        <div class="topic">${topic}</div>
                        <div class="value">${value}</div>
                    `;
                    messageList.appendChild(messageElement);
                });
            })
            .catch(error => console.error('Error fetching messages:', error));
    }
    
    categoryFilter.addEventListener('change', fetchMessages);
    refreshButton.addEventListener('click', fetchMessages);
    
    // Initial fetch
    fetchMessages();
    