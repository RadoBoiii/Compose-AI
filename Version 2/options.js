// ComposeAI - Options handling

// Cache settings
const settings = {};
const settingsForm = document.getElementById("settingsForm");
const apiStatus = document.getElementById("apiStatus");
const tempValue = document.getElementById("tempValue");
const debounceValue = document.getElementById("debounceValue");
const saveButton = document.getElementById("saveButton");

// Validate OpenAI API key
async function validateApiKey(apiKey) {
  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });
    
    if (!response.ok) {
      throw new Error('Invalid API key');
    }
    
    return true;
  } catch (error) {
    return false;
  }
}

// Show status message
function showStatus(message, isError = false) {
  apiStatus.textContent = message;
  apiStatus.className = `status ${isError ? 'error' : 'success'}`;
  
  // Show the status message
  setTimeout(() => {
    apiStatus.className = 'status';
  }, 3000);
}

// Format debounce time display
function formatDebounceTime(value) {
  return `${Number(value).toFixed(1)}s`;
}

// Save settings to Chrome storage
async function saveSettings(e) {
  e.preventDefault();
  
  const apiKey = document.getElementById('apiKey').value;
  const modelTemp = document.getElementById('modelTemp').value;
  const debounceTime = document.getElementById('debounceTime').value;
  const waitForPause = document.getElementById('waitForPause').checked;
  const useGhostText = document.getElementById('useGhostText').checked;
  const isEnabled = document.getElementById('isEnabled').checked;

  // Validate API key if provided
  if (apiKey) {
    saveButton.disabled = true;
    saveButton.textContent = 'Validating...';
    
    const isValid = await validateApiKey(apiKey);
    
    saveButton.disabled = false;
    saveButton.textContent = 'Save Settings';
    
    if (!isValid) {
      showStatus('Invalid API key. Please check and try again.', true);
      return;
    }
  }

  // Save to storage
  try {
    await chrome.storage.sync.set({
      apiKey,
      modelTemp,
      debounceTime,
      waitForPause,
      useGhostText,
      isEnabled
    });

    showStatus('Settings saved successfully!');
    
    console.log('ComposeAI: Settings saved', {
      modelTemp,
      debounceTime,
      waitForPause,
      useGhostText,
      isEnabled,
      hasApiKey: !!apiKey
    });
  } catch (error) {
    console.error('ComposeAI: Error saving settings', error);
    showStatus('Error saving settings. Please try again.', true);
  }
}

// Initialize the settings in the popup
async function loadSettings() {
  try {
    const stored = await chrome.storage.sync.get([
      'apiKey', 
      'modelTemp', 
      'debounceTime', 
      'waitForPause', 
      'useGhostText', 
      'isEnabled'
    ]);
    
    // Set API key if it exists
    if (stored.apiKey) {
      document.getElementById('apiKey').value = stored.apiKey;
    }
    
    // Set model temperature
    const temp = stored.modelTemp || '0.7';
    const tempInput = document.getElementById('modelTemp');
    tempInput.value = temp;
    tempValue.textContent = temp;
    
    // Set debounce time
    const debounceTime = stored.debounceTime || '0.3';
    const debounceInput = document.getElementById('debounceTime');
    debounceInput.value = debounceTime;
    debounceValue.textContent = formatDebounceTime(debounceTime);
    
    // Set checkboxes
    const waitForPause = stored.waitForPause || false;
    document.getElementById('waitForPause').checked = waitForPause;
    
    const useGhostText = stored.useGhostText !== false; // Default to true
    document.getElementById('useGhostText').checked = useGhostText;
    
    const isEnabled = stored.isEnabled !== false; // Default to true
    document.getElementById('isEnabled').checked = isEnabled;
    
    console.log('ComposeAI: Settings loaded', {
      modelTemp: temp,
      debounceTime,
      waitForPause,
      useGhostText,
      isEnabled,
      hasApiKey: !!stored.apiKey
    });
  } catch (error) {
    console.error('ComposeAI: Error loading settings', error);
  }
}

// Update temperature display when slider moves
document.getElementById('modelTemp').addEventListener('input', (e) => {
  tempValue.textContent = e.target.value;
});

// Update debounce time display when slider moves
document.getElementById('debounceTime').addEventListener('input', (e) => {
  debounceValue.textContent = formatDebounceTime(e.target.value);
});

// Call loadSettings when the popup is loaded
document.addEventListener('DOMContentLoaded', loadSettings);

// Add form submit handler
settingsForm.addEventListener('submit', saveSettings);