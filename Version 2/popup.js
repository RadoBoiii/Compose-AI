// Initialize preset buttons and model selectors
document.addEventListener('DOMContentLoaded', function() {
  // Creativity preset buttons
  const creativityButtons = document.querySelectorAll('.preset-buttons:first-of-type .preset-button');
  creativityButtons.forEach(button => {
    button.addEventListener('click', function() {
      creativityButtons.forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      document.getElementById('modelTemp').value = this.dataset.value;
    });
  });

  // Response speed preset buttons
  const speedButtons = document.querySelectorAll('.preset-buttons:nth-of-type(2) .preset-button');
  speedButtons.forEach(button => {
    button.addEventListener('click', function() {
      speedButtons.forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      document.getElementById('debounceTime').value = this.dataset.value;
    });
  });

  // Model selection
  const modelOptions = document.querySelectorAll('.model-option');
  modelOptions.forEach(option => {
    option.addEventListener('click', function() {
      modelOptions.forEach(o => o.classList.remove('active'));
      this.classList.add('active');
      document.getElementById('selectedModel').value = this.dataset.model;
      
      // Update the API key label based on selected model
      const apiKeyLabel = document.querySelector('label[for="apiKey"]');
      apiKeyLabel.textContent = this.dataset.model === 'gpt' ? 'OpenAI API Key' : 'Google Gemini API Key';
    });
  });
});