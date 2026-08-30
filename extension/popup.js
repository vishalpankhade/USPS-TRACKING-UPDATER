document.getElementById('open').addEventListener('click', async()=>{await chrome.tabs.create({url:chrome.runtime.getURL('dashboard.html')});window.close();});
