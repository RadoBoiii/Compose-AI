// Compose AI - Content Script
const debug = true;

// State tracking
let activeElement = null;
let activeObserver = null;
let lastTypingTime = Date.now();
let debounceTimer = null;
let lastCompletionTime = 0;
let hasTypedSinceCompletion = true;
let currentGhostText = null;
let currentSuggestion = null;
let currentLastWord = null;
let isExtensionDisconnected = false; // Flag to track extension connection status
let reconnectionAttempts = 0;
let connectionCheckTimer = null;

// Default settings
let settings = { 
  debounceTime: 300, 
  waitForPause: false, 
  useGhostText: true,
  isEnabled: true
};

// More graceful approach - check connection status without establishing a port
function checkExtensionConnection() {
  try {
    // Just check if we can access chrome.runtime.id, which will throw an error if disconnected
    const id = chrome.runtime.id;
    return true;
  } catch (error) {
    console.log('ComposeAI: Extension context check failed:', error);
    isExtensionDisconnected = true;
    return false;
  }
}

// Send message to background script with error handling
function sendMessageSafely(message) {
  return new Promise((resolve, reject) => {
    // First check if we're already disconnected
    if (isExtensionDisconnected) {
      console.log('ComposeAI: Extension context is invalid, can\'t send update');
      return reject(new Error('Extension context invalidated'));
    }
    
    try {
      // Try to send the message with a timeout to prevent hanging
      const timeoutId = setTimeout(() => {
        isExtensionDisconnected = true;
        reject(new Error('Message sending timed out'));
      }, 5000);
      
      chrome.runtime.sendMessage(message, (response) => {
        clearTimeout(timeoutId);
        // Check for error
        if (chrome.runtime.lastError) {
          console.log('ComposeAI: Error sending message:', chrome.runtime.lastError);
          isExtensionDisconnected = true;
          reject(chrome.runtime.lastError);
        } else {
          resolve(response);
        }
      });
    } catch (error) {
      console.log('ComposeAI: Exception sending message:', error);
      isExtensionDisconnected = true;
      reject(error);
    }
  });
}

// Load settings from storage safely
async function loadSettings() {
  try {
    if (isExtensionDisconnected) {
      console.log('ComposeAI: Can\'t load settings - extension disconnected');
      return;
    }
    
    // Try to get from storage with timeout
    const stored = await Promise.race([
      chrome.storage.sync.get(['debounceTime', 'waitForPause', 'useGhostText', 'isEnabled']),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Storage timeout')), 2000))
    ]);
    
    settings.debounceTime = parseFloat(stored.debounceTime || 0.3) * 1000; // Convert to milliseconds
    settings.waitForPause = stored.waitForPause || false;
    settings.useGhostText = stored.useGhostText !== false; // Default to true if not set
    settings.isEnabled = stored.isEnabled !== false; // Default to true if not set
    
    if (debug) {
      console.log('ComposeAI: Settings loaded', settings);
    }
  } catch (error) {
    console.log('ComposeAI: Error loading settings:', error);
    // Use default settings if loading fails
    settings = { 
      debounceTime: 300, 
      waitForPause: false, 
      useGhostText: true,
      isEnabled: true
    };
  }
}

// Check for connection status and load settings if connected
function initializeExtension() {
  // Check if extension is connected
  if (checkExtensionConnection()) {
    isExtensionDisconnected = false;
    loadSettings();
    
    // Set up a timer to periodically check connection status
    if (connectionCheckTimer) {
      clearInterval(connectionCheckTimer);
    }
    
    connectionCheckTimer = setInterval(() => {
      // Only try to send a ping if we're not already disconnected
      if (!isExtensionDisconnected) {
        try {
          sendMessageSafely({ type: 'PING' }).catch(error => {
            console.log('ComposeAI: Connection check failed:', error);
            isExtensionDisconnected = true;
          });
        } catch (error) {
          console.log('ComposeAI: Connection check error:', error);
          isExtensionDisconnected = true;
        }
      }
    }, 30000); // Check every 30 seconds
    
    return true;
  } else {
    console.log('ComposeAI: Extension initialization failed - disconnected');
    isExtensionDisconnected = true;
    return false;
  }
}

// Try to initialize the extension - do this only once at startup
initializeExtension();

/* Helper functions for UI components */
function createTooltip(message, isLoading = false, isError = false, alternatives = []) {
  if (!activeElement) return null;

  try {
    const tooltip = document.createElement('div');
    tooltip.className = `compose-tooltip ${isLoading ? 'loading' : ''} ${isError ? 'error' : ''}`;
    
    if (isLoading) {
      const spinner = document.createElement('div');
      spinner.className = 'compose-spinner';
      tooltip.appendChild(spinner);
      tooltip.appendChild(document.createTextNode('Compose AI is thinking...'));
      return tooltip;
    }

    if (isError) {
      tooltip.appendChild(document.createTextNode(message));
      return tooltip;
    }

    // Get the current word being typed
    const element = activeElement;
    const content = getEditorContent(element);
    const cursorPos = getCursorPosition(element);
    const textBeforeCursor = content.slice(0, cursorPos);
    const currentWordMatch = textBeforeCursor.match(/\S+$/);
    const currentWord = currentWordMatch ? currentWordMatch[0] : '';
    const afterCursor = content.slice(cursorPos);
    const cursorHasSpace = textBeforeCursor.endsWith(' ');

    // Determine the last complete word
    let lastCompleteWord = '';
    if (cursorHasSpace) {
      // If cursor is after a space, get the last word before the space
      const words = textBeforeCursor.trim().split(/\s+/);
      lastCompleteWord = words[words.length - 1] || '';
    } else if (!currentWord) {
      // If no current word and no space, get the last complete word
      const words = textBeforeCursor.trim().split(/\s+/);
      lastCompleteWord = words[words.length - 1] || '';
    } else {
      // If there's a current word, check if it's complete
      const words = textBeforeCursor.slice(0, -currentWord.length).trim().split(/\s+/);
      lastCompleteWord = words[words.length - 1] || '';
    }

    // Create a container for the completion text
    const completionText = document.createElement('div');
    completionText.className = 'compose-completion';
    
    let remainingText = '';
    if (currentWord) {
      // If we have a current suggestion and we're typing it
      if (currentSuggestion && currentSuggestion.toLowerCase().includes(textBeforeCursor.toLowerCase().trim())) {
        // Find where in the suggestion we currently are
        const normalizedSuggestion = currentSuggestion.toLowerCase();
        const normalizedTyped = textBeforeCursor.toLowerCase().trim();
        const index = normalizedSuggestion.indexOf(normalizedTyped);
        if (index !== -1) {
          // Show only what's left after what we've typed
          remainingText = currentSuggestion.slice(index + normalizedTyped.length);
        }
      } else {
        // Split both the suggestion and typed text into words
        const messageWords = message.split(' ');
        const firstWord = messageWords[0];
        
        if (firstWord.toLowerCase().startsWith(currentWord.toLowerCase())) {
          // Show remaining part of the first word without space
          const remainingPart = firstWord.slice(currentWord.length);
          remainingText = remainingPart;
          
          // Add any following words with proper spacing
          if (messageWords.length > 1) {
            remainingText += ' ' + messageWords.slice(1).join(' ');
          }
        } else {
          // Add space if we're after a complete word and don't have a space
          const needsSpace = !cursorHasSpace && lastCompleteWord !== '';
          remainingText = (needsSpace ? ' ' : '') + message;
        }
      }
    } else {
      // No current word being typed
      // Add space if we're after a complete word and don't have a space
      const needsSpace = !cursorHasSpace && lastCompleteWord !== '';
      remainingText = (needsSpace ? ' ' : '') + message;
    }

    if (debug) {
      console.log('ComposeAI: Tooltip text analysis:', {
        currentWord,
        message,
        remainingText,
        textBeforeCursor,
        cursorHasSpace,
        lastCompleteWord,
        currentLastWord: lastCompleteWord,
        afterCursor,
        currentSuggestion
      });
    }

    if (!remainingText.trim()) {
      return null;
    }

    // Don't trim the leading space if we need it
    completionText.textContent = remainingText;
    tooltip.appendChild(completionText);

    // Add alternatives if available
    if (alternatives && alternatives.length > 0) {
      const altContainer = document.createElement('div');
      altContainer.className = 'compose-alternatives';
      
      alternatives.forEach((alt, index) => {
        const altText = document.createElement('div');
        altText.className = 'compose-alt-item';
        
        let altRemaining = '';
        if (currentWord) {
          const altWords = alt.split(' ');
          const firstWord = altWords[0];
          
          if (firstWord.toLowerCase().startsWith(currentWord.toLowerCase())) {
            // Show remaining part of the first word without space
            const remainingPart = firstWord.slice(currentWord.length);
            altRemaining = remainingPart;
            
            // Add any following words with proper spacing
            if (altWords.length > 1) {
              altRemaining += ' ' + altWords.slice(1).join(' ');
            }
          } else {
            // Add space if needed
            const needsSpace = !cursorHasSpace && lastCompleteWord !== '';
            altRemaining = (needsSpace ? ' ' : '') + alt;
          }
        } else {
          // Add space if needed
          const needsSpace = !cursorHasSpace && lastCompleteWord !== '';
          altRemaining = (needsSpace ? ' ' : '') + alt;
        }

        if (altRemaining.trim()) {
          altText.textContent = `${index + 1}: ${altRemaining}`;
          altText.dataset.index = index;
          altText.dataset.text = altRemaining;
          altContainer.appendChild(altText);
        }
      });
      
      if (altContainer.children.length > 0) {
        tooltip.appendChild(altContainer);
      }
    }

    // Add usage hint
    const hint = document.createElement('div');
    hint.className = 'compose-hint';
    hint.textContent = alternatives.length > 0 
      ? 'Press Tab to accept or 1-3 for alternatives. Esc to dismiss' 
      : 'Press Tab to accept or Esc to dismiss';
    tooltip.appendChild(hint);

    // Update currentLastWord for future reference
    currentLastWord = lastCompleteWord;

    // Set tooltip styles for positioning
    tooltip.style.position = 'absolute';
    tooltip.style.zIndex = '999999';
    tooltip.style.whiteSpace = 'pre';

    // Support dark mode
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      tooltip.classList.add('dark-mode');
    }

    return tooltip;
  } catch (error) {
    console.log('ComposeAI: Error creating tooltip:', error);
    return null;
  }
}

function positionTooltip(tooltip, target) {
  if (!tooltip || !target) {
    console.log('ComposeAI: Cannot position tooltip - tooltip or target is null');
    return;
  }

  try {
    const rect = target.getBoundingClientRect();
    const cursorPos = getCursorPosition(target);
    const content = getEditorContent(target);
    const textBeforeCursor = content.slice(0, cursorPos);
    
    // Create a temporary span to measure text width
    const measureSpan = document.createElement('span');
    measureSpan.style.visibility = 'hidden';
    measureSpan.style.position = 'absolute';
    measureSpan.style.whiteSpace = 'pre';
    measureSpan.style.font = window.getComputedStyle(target).font;
    measureSpan.textContent = textBeforeCursor;
    document.body.appendChild(measureSpan);
    
    // Calculate position
    const textWidth = measureSpan.getBoundingClientRect().width;
    measureSpan.remove();
    
    // Account for padding and border in input elements
    const style = window.getComputedStyle(target);
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    
    // Adjust for content editable or textarea
    const leftOffset = target.isContentEditable ? 
      rect.left : 
      rect.left + paddingLeft + borderLeft;
    
    // Position the tooltip below the cursor
    const tooltipTop = rect.bottom + window.scrollY + 5; // 5px gap
    const tooltipLeft = leftOffset + textWidth;

    tooltip.style.left = `${tooltipLeft}px`;
    tooltip.style.top = `${tooltipTop}px`;
    
    document.body.appendChild(tooltip);

    // Ensure tooltip is visible within viewport
    const tooltipRect = tooltip.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Handle horizontal positioning
    if (tooltipRect.right > viewportWidth) {
      tooltip.style.left = `${viewportWidth - tooltipRect.width - 10}px`;
    }

    // Handle vertical positioning
    if (tooltipRect.bottom > viewportHeight) {
      // Position above the target
      tooltip.style.top = `${rect.top + window.scrollY - tooltipRect.height - 10}px`;
      tooltip.classList.add('position-above');
    } else {
      // Position below the target
      tooltip.classList.remove('position-above');
    }
  } catch (error) {
    console.log('ComposeAI: Error positioning tooltip:', error);
    if (tooltip && document.body.contains(tooltip)) {
      tooltip.remove();
    }
  }
}

// Handle input events with error handling
function handleInput(event) {
  // Skip processing if disconnected or disabled
  if (isExtensionDisconnected || !settings.isEnabled) {
    return;
  }
  
  const element = event.target;
  
  if (!isValidInputField(element)) return;

  // Get content and cursor position
  let content, cursorPos;
  try {
    content = getEditorContent(element);
    cursorPos = getCursorPosition(element);
  } catch (error) {
    console.log('ComposeAI: Error getting editor content:', error);
    return;
  }
  
  const textBeforeCursor = content.slice(0, cursorPos);
  const currentWordMatch = textBeforeCursor.match(/\S+$/);
  const currentWord = currentWordMatch ? currentWordMatch[0] : '';
  const fullTextBeforeCursor = textBeforeCursor.trim();
  let isMatchingWord = false;

  // Skip the rest of the function if ghost text is present and we're typing a space
  if ((event.inputType === 'insertText' && event.data === ' ') && currentGhostText) {
    if (debug) {
      console.log('ComposeAI: Skipping - Space with ghost text');
    }
    return;
  }

  // Check if we're currently typing the suggestion
  if (currentSuggestion && currentLastWord) {
    // Split both the suggestion and typed text into words
    const suggestionWords = currentSuggestion.split(' ');
    const typedWords = fullTextBeforeCursor.split(' ');
    
    // Track where we are in the suggestion
    let currentWordIndex = -1;
    let remainingText = '';
    let completeWord = '';

    // If we just typed a space, check if we were at the end of a word that matches the suggestion
    if (!currentWord && textBeforeCursor.endsWith(' ')) {
      const lastTypedWord = typedWords[typedWords.length - 1];
      // Find this word in the suggestion
      currentWordIndex = suggestionWords.findIndex(word => 
        word.toLowerCase() === lastTypedWord?.toLowerCase()
      );
      isMatchingWord = currentWordIndex !== -1;

      // If we found a match and there are more words in the suggestion, keep showing it
      if (isMatchingWord && currentWordIndex < suggestionWords.length - 1) {
        remainingText = suggestionWords.slice(currentWordIndex + 1).join(' ');
        completeWord = suggestionWords[currentWordIndex + 1];
        
        // Don't trigger AI call if we're still matching the suggestion
        if (event.inputType === undefined || (event.inputType === 'insertText' && event.data === ' ')) {
          if (debug) {
            console.log('ComposeAI: Skipping AI call:', {
              reason: 'Space after matching word in suggestion',
              eventType: event.inputType,
              eventData: event.data,
              lastTypedWord,
              currentWordIndex,
              remainingText
            });
          }
          return;
        }
      }
    } else if (currentWord) {
      // Find if we're typing any word in the suggestion
      currentWordIndex = suggestionWords.findIndex(word => 
        word.toLowerCase().startsWith(currentWord.toLowerCase())
      );
      isMatchingWord = currentWordIndex !== -1;

      if (isMatchingWord) {
        // For partial word matches, find the complete word we're matching
        const matchedWord = suggestionWords[currentWordIndex];
        completeWord = matchedWord;
        
        // Calculate remaining text based on complete word
        const remainingPart = matchedWord.slice(currentWord.length);
        remainingText = remainingPart;
        
        // Only add following words if we have them
        if (currentWordIndex < suggestionWords.length - 1) {
          // Add space only before additional words, not the remaining part of current word
          remainingText += ' ' + suggestionWords.slice(currentWordIndex + 1).join(' ');
        }
      }
    }

    if (debug) {
      console.log('ComposeAI: Suggestion Analysis:', {
        currentWord,
        fullTextBeforeCursor,
        currentSuggestion,
        currentLastWord,
        currentWordIndex,
        isMatchingWord,
        suggestionWords,
        typedWords,
        remainingText,
        completeWord,
        eventType: event.inputType,
        eventData: event.data
      });
    }

    // Update UI if we're typing the suggestion
    if (isMatchingWord) {
      if (settings.useGhostText) {
        removeGhostText();
        const ghostText = createGhostText(remainingText, currentLastWord, completeWord);
        
        // Add keyboard event listener for ghost text
        if (ghostText) {
          function ghostKeydownHandler(e) {
            if (e.key === 'Tab') {
              e.preventDefault();
              if (debug) {
                console.log('ComposeAI: Removing ghost text:', {
                  reason: 'Tab key pressed',
                  currentWord: currentWord || currentLastWord,
                  remainingText,
                  completeWord
                });
              }
              handleCompletion(remainingText, currentWord || currentLastWord, completeWord);
              removeGhostText();
              resetSuggestionState();
            } else if (e.key === 'Escape' || e.key === 'Enter') {
              if (debug) {
                console.log('ComposeAI: Removing ghost text:', {
                  reason: e.key + ' key pressed',
                  currentWord: currentWord || currentLastWord,
                  remainingText,
                  completeWord
                });
              }
              removeGhostText();
              resetSuggestionState();
            }
          }

          document.addEventListener('keydown', ghostKeydownHandler);

          // Remove event listener when ghost text is removed
          const ghostObserver = new MutationObserver((mutations) => {
            if (!document.body.contains(ghostText)) {
              document.removeEventListener('keydown', ghostKeydownHandler);
              ghostObserver.disconnect();
            }
          });

          ghostObserver.observe(document.body, {
            childList: true,
            subtree: true
          });
        }
      } else {
        // Update tooltip with remaining text
        document.querySelectorAll('.compose-tooltip').forEach(t => t.remove());
        
        if (remainingText.trim()) {
          const tooltip = createTooltip(remainingText, false, false, []);
          if (tooltip) {
            positionTooltip(tooltip, element);
            addTooltipKeydownHandler(tooltip, currentSuggestion, currentLastWord);
          }
        }
      }
      return;
    }
  }

  // Only set hasTypedSinceCompletion to true if this is a real user input event
  if (event.inputType && (event.inputType.startsWith('insert') || event.inputType === 'deleteContentBackward')) {
    if (!(event.inputType === 'insertText' && event.data === ' ' && currentGhostText)) {
      hasTypedSinceCompletion = true;
    }
  }

  // Remove UI elements if we're not typing the suggestion
  if (!(event.inputType === 'insertText' && event.data === ' ' && currentGhostText) && 
      !(event.inputType === undefined && currentGhostText)) {
    document.querySelectorAll('.compose-tooltip').forEach(t => {
      if (debug) console.log('ComposeAI: Tooltip removed - Not typing suggestion anymore');
      t.remove();
    });
    
    if (debug) {
      console.log('ComposeAI: Removing ghost text:', {
        reason: 'Not typing suggestion anymore',
        currentWord,
        currentSuggestion,
        currentLastWord,
        isMatchingWord,
        fullTextBeforeCursor,
        eventType: event.inputType,
        eventData: event.data,
        hasGhostText: !!currentGhostText
      });
    }
    
    removeGhostText();

    // Clear current suggestion since we're not typing it
    currentSuggestion = null;
    currentLastWord = null;
  }

  // Update last typing time
  lastTypingTime = Date.now();

  // Clear existing timer
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  // Skip AI call if we're typing a space and there's ghost text
  if ((event.inputType === undefined || (event.inputType === 'insertText' && event.data === ' ')) && currentGhostText) {
    if (debug) {
      console.log('ComposeAI: Skipping AI call:', {
        reason: 'Space typed with ghost text present',
        ghostTextContent: currentGhostText.textContent,
        eventType: event.inputType,
        eventData: event.data
      });
    }
    return;
  }

  // Log input detection if in debug mode
  if (debug) {
    console.log('ComposeAI Input Detected:', {
      content: content,
      cursorPosition: cursorPos,
      elementType: element.tagName,
      elementClass: element.className,
      timeSinceLastCompletion: Date.now() - lastCompletionTime,
      hasTypedSinceCompletion: hasTypedSinceCompletion,
      eventType: event.inputType,
      eventData: event.data,
      hasGhostText: !!currentGhostText
    });
  }

  // Only proceed if there's actual content and user has typed since last completion
  if (!content.trim() || !hasTypedSinceCompletion) {
    if (debug) {
      console.log('ComposeAI: Skipping suggestion:', {
        emptyContent: !content.trim(),
        hasTypedSinceCompletion: hasTypedSinceCompletion
      });
    }
    return;
  }

  // Check if we should wait for typing pause
  const shouldWaitForPause = settings.waitForPause;
  const debounceTime = settings.debounceTime;

  // Set a timer for sending the update
  debounceTimer = setTimeout(async () => {
    // If waiting for pause is enabled, check if user has stopped typing
    if (shouldWaitForPause) {
      const timeSinceLastType = Date.now() - lastTypingTime;
      if (timeSinceLastType < debounceTime) {
        return;
      }
    }

    // Check connection status before proceeding
    if (isExtensionDisconnected) {
      console.log('ComposeAI: Skipping API call - extension disconnected');
      return;
    }
    
    try {
      // Show loading tooltip
      const loadingTooltip = createTooltip('', true);
      if (loadingTooltip) {
        positionTooltip(loadingTooltip, element);
      }

      // Get context from the page
      const context = {
        title: document.title,
        description: document.querySelector('meta[name="description"]')?.content || '',
        nearbyText: getNearbyText(element),
        headings: Array.from(document.querySelectorAll('h1, h2, h3')).map(h => h.textContent).join(' | '),
        formContext: element.form ? Array.from(element.form.elements).map(e => e.name || e.id || '').join(' ') : '',
        inputContext: {
          placeholder: element instanceof HTMLInputElement ? element.placeholder : '',
          label: getInputLabel(element),
          name: element instanceof HTMLInputElement ? element.name : '',
          type: element instanceof HTMLInputElement ? element.type : 'text'
        }
      };

      // Send message to background script - carefully handle errors
      try {
        await sendMessageSafely({
          type: 'TEXT_BOX_UPDATED',
          textBoxContent: content,
          cursorPosition: cursorPos,
          context: context,
          hasTypedSinceCompletion: hasTypedSinceCompletion
        });
      } catch (error) {
        // If sending fails, remove the loading tooltip
        if (loadingTooltip) {
          loadingTooltip.remove();
        }
        console.log('ComposeAI: Failed to send update to background script:', error);
        
        // Try to reconnect automatically
        if (isExtensionDisconnected) {
          scheduleReconnection();
        }
      }
    } catch (error) {
      console.log('ComposeAI: Error in input handler:', error);
    }
  }, debounceTime);
}

// Set up mutation observer for dynamic content
function observeElement(element) {
  try {
    if (activeObserver) {
      activeObserver.disconnect();
    }

    activeObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData' || mutation.type === 'childList') {
          handleInput({ target: element });
        }
      }
    });

    activeObserver.observe(element, {
      characterData: true,
      childList: true,
      subtree: true
    });
  } catch (error) {
    console.log('ComposeAI: Error setting up observer:', error);
  }
}

// Handle focus event
function handleFocus(event) {
  if (isExtensionDisconnected) return;
  
  try {
    const element = event.target;
    
    if (!isValidInputField(element)) return;
    
    activeElement = element;
    observeElement(element);
    
    if (debug) {
      console.log('ComposeAI: Input field focused', {
        type: element.tagName,
        class: element.className
      });
    }
  } catch (error) {
    console.log('ComposeAI: Error in focus handler:', error);
  }
}

// Handle blur event
function handleBlur(event) {
  try {
    if (activeObserver) {
      activeObserver.disconnect();
    }
    activeElement = null;
    
    // Clean up UI elements when focus is lost
    document.querySelectorAll('.compose-tooltip').forEach(t => t.remove());
    removeGhostText();
  } catch (error) {
    console.log('ComposeAI: Error in blur handler:', error);
  }
}

// Handle keydown event
function handleKeydown(event) {
  try {
    if (event.key === 'Enter') {
      resetSuggestionState();
    }
  } catch (error) {
    console.log('ComposeAI: Error in keydown handler:', error);
  }
}

// Handle click event
function handleClick(event) {
  try {
    // Check if clicked element is a button or link
    if (event.target.tagName === 'BUTTON' || 
        event.target.tagName === 'A' || 
        event.target.closest('button') || 
        event.target.closest('a') ||
        event.target.getAttribute('role') === 'button' ||
        event.target.type === 'submit') {
      resetSuggestionState();
    }
  } catch (error) {
    console.log('ComposeAI: Error in click handler:', error);
  }
}

// Handle form submission
function handleSubmit(event) {
  try {
    resetSuggestionState();
  } catch (error) {
    console.log('ComposeAI: Error in submit handler:', error);
  }
}

// Attach event listeners safely
function attachEventListeners() {
  try {
    document.removeEventListener('focus', handleFocus, true);
    document.removeEventListener('blur', handleBlur, true);
    document.removeEventListener('input', handleInput, true);
    document.removeEventListener('keydown', handleKeydown, true);
    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('submit', handleSubmit, true);
    
    document.addEventListener('focus', handleFocus, true);
    document.addEventListener('blur', handleBlur, true);
    document.addEventListener('input', handleInput, true);
    document.addEventListener('keydown', handleKeydown, true);
    document.addEventListener('click', handleClick, true);
    document.addEventListener('submit', handleSubmit, true);
    
    console.log('ComposeAI: Event listeners attached');
  } catch (error) {
    console.log('ComposeAI: Error attaching event listeners:', error);
  }
}

// Attach event listeners on script load
attachEventListeners();

// Schedule a reconnection attempt with exponential backoff
function scheduleReconnection() {
  if (reconnectionAttempts > 10) {
    console.log('ComposeAI: Too many reconnection attempts, giving up');
    return;
  }
  
  const backoffTime = Math.min(30000, Math.pow(2, reconnectionAttempts) * 1000);
  console.log(`ComposeAI: Scheduling reconnection in ${backoffTime/1000} seconds`);
  
  setTimeout(() => {
    console.log('ComposeAI: Attempting to reconnect...');
    if (initializeExtension()) {
      reconnectionAttempts = 0;
      console.log('ComposeAI: Reconnection successful');
    } else {
      reconnectionAttempts++;
      console.log(`ComposeAI: Reconnection failed (attempt ${reconnectionAttempts})`);
    }
  }, backoffTime);
}

// Handle completion acceptance
function handleCompletion(completionText, lastWord = '', completeWord = '') {
  try {
    const element = activeElement;
    if (!element) return;

    // Update completion tracking
    lastCompletionTime = Date.now();
    hasTypedSinceCompletion = false;
    
    // Clear any existing timer and remove tooltips
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    const content = getEditorContent(element);
    const cursorPos = getCursorPosition(element);
    const textBeforeCursor = content.slice(0, cursorPos);
    const currentWordMatch = textBeforeCursor.match(/\S+$/);
    const currentWord = currentWordMatch ? currentWordMatch[0] : '';
    const afterCursor = content.slice(cursorPos);
    const cursorHasSpace = textBeforeCursor.endsWith(' ');

    // If we have ghost text, use its content directly
    if (currentGhostText) {
      const ghostTextContent = currentGhostText.textContent;
      // Keep the current word if it's part of what we're completing
      const finalText = textBeforeCursor + ghostTextContent;
      
      // Add any text that was after the cursor
      const needsSpaceAfter = afterCursor.length > 0 && !afterCursor.startsWith(' ');
      const completeText = finalText + (needsSpaceAfter ? ' ' : '') + afterCursor;
      
      // Set cursor position to end of inserted completion
      const newCursorPos = finalText.length;

      if (debug) {
        console.log('ComposeAI: Ghost Text Completion:', {
          currentWord,
          ghostTextContent,
          finalText,
          completeText,
          newCursorPos
        });
      }

      updateEditorContent(element, completeText, newCursorPos);
      return;
    }

    // Split the completion into words
    const completionWords = completionText.split(' ');
    const firstCompletionWord = completionWords[0];
    
    let insertText = '';
    
    if (currentWord) {
      // Check if the first word of completion starts with current word
      if (firstCompletionWord.toLowerCase().startsWith(currentWord.toLowerCase())) {
        // Complete the current word and add remaining words
        insertText = completionText.slice(currentWord.length);
      } else {
        // Add space if cursor is at end of word and no space exists
        const needsSpace = !cursorHasSpace;
        insertText = (needsSpace ? ' ' : '') + completionText;
      }
    } else {
      // No current word, add space if needed
      const needsSpace = !cursorHasSpace;
      insertText = (needsSpace ? ' ' : '') + completionText;
    }

    // Construct the final text
    const finalText = textBeforeCursor + insertText;
    
    // Add any text that was after the cursor
    const needsSpaceAfter = afterCursor.length > 0 && !afterCursor.startsWith(' ');
    const completeText = finalText + (needsSpaceAfter ? ' ' : '') + afterCursor;
    
    // Set cursor position to end of inserted completion
    const newCursorPos = finalText.length;

    if (debug) {
      console.log('ComposeAI: Completion Analysis:', {
        currentWord,
        completionText,
        completeWord,
        lastWord,
        insertText,
        finalText,
        completeText,
        newCursorPos,
        cursorHasSpace
      });
    }

    updateEditorContent(element, completeText, newCursorPos);
  } catch (error) {
    console.log('ComposeAI: Error in handleCompletion:', error);
  }
}

// Update content in different types of editors
function updateEditorContent(element, newContent, cursorPosition) {
  try {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.value = newContent;
      element.selectionStart = cursorPosition;
      element.selectionEnd = cursorPosition;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (element.isContentEditable) {
      element.textContent = newContent;
      const selection = window.getSelection();
      const range = document.createRange();
      
      // Find the text node and position
      let currentNode = element.firstChild;
      let currentPos = 0;
      while (currentNode) {
        if (currentNode.nodeType === Node.TEXT_NODE) {
          const length = currentNode.length;
          if (currentPos + length >= cursorPosition) {
            range.setStart(currentNode, cursorPosition - currentPos);
            range.setEnd(currentNode, cursorPosition - currentPos);
            break;
          }
          currentPos += length;
        }
        currentNode = currentNode.nextSibling;
      }
      
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (element.classList && element.classList.contains('monaco-editor')) {
      const model = element.querySelector('.monaco-editor')?.['_modelData']?.['model'];
      if (model) {
        const position = model.getPositionAt(cursorPosition);
        model.setValue(newContent);
        model.setPosition(position);
      }
    } else if (element.classList && element.classList.contains('CodeMirror')) {
      const cm = element.CodeMirror;
      if (cm) {
        cm.setValue(newContent);
        const pos = cm.posFromIndex(cursorPosition);
        cm.setCursor(pos);
      }
    }
  } catch (error) {
    console.log('ComposeAI: Error updating editor content:', error);
  }
}

// Function to remove tooltips and reset typing state
function resetSuggestionState() {
  try {
    if (isExtensionDisconnected) return;
    
    // Check if we're typing the suggestion before removing UI elements
    if (activeElement) {
      const content = getEditorContent(activeElement);
      const cursorPos = getCursorPosition(activeElement);
      const textBeforeCursor = content.slice(0, cursorPos);
      const currentWordMatch = textBeforeCursor.match(/\S+$/);
      const currentWord = currentWordMatch ? currentWordMatch[0] : '';
      
      const isTypingSuggestion = currentLastWord && currentWord &&
        (currentLastWord.toLowerCase().startsWith(currentWord.toLowerCase()) ||
         currentSuggestion?.toLowerCase().startsWith(currentWord.toLowerCase()));
         
      if (isTypingSuggestion) {
        if (debug) {
          console.log('ComposeAI: Keeping ghost text:', {
            reason: 'Still typing suggestion',
            currentWord,
            currentSuggestion,
            currentLastWord
          });
        }
        return; // Don't reset state if typing suggestion
      }
    }

    document.querySelectorAll('.compose-tooltip').forEach(t => {
      console.log('ComposeAI: Tooltip removed - Reset suggestion state');
      t.remove();
    });
    
    removeGhostText();
    hasTypedSinceCompletion = false;
    currentSuggestion = null;
    currentLastWord = null;
    
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    
    if (debug) {
      console.log('ComposeAI: Reset suggestion state due to user action');
    }
  } catch (error) {
    console.log('ComposeAI: Error in resetSuggestionState:', error);
  }
}

// Create ghost text element
function createGhostText(completion, lastWord, completeWord = '') {
  try {
    if (!completion || !activeElement) {
      if (debug) {
        console.log('ComposeAI: Ghost text creation skipped:', {
          reason: !completion ? 'No completion text' : 'No active element',
          completion,
          activeElement
        });
      }
      return null;
    }

    // Get the computed style of the input
    const computedStyle = window.getComputedStyle(activeElement);
    
    // Create ghost text element
    const ghostText = document.createElement('div');
    ghostText.className = 'compose-ghost-text';
    
    // Get the current word being typed
    const content = getEditorContent(activeElement);
    const cursorPos = getCursorPosition(activeElement);
    const textBeforeCursor = content.slice(0, cursorPos);
    const currentWordMatch = textBeforeCursor.match(/\S+$/);
    const currentWord = currentWordMatch ? currentWordMatch[0] : '';
    const afterCursor = content.slice(cursorPos);
    const cursorHasSpace = textBeforeCursor.endsWith(' ');

    // Format the ghost text content
    let ghostTextContent = '';
    
    if (currentWord && completeWord) {
      // We have a complete word to match against
      if (completeWord.toLowerCase().startsWith(currentWord.toLowerCase())) {
        // Show remaining part of the first word
        const remainingPart = completeWord.slice(currentWord.length);
        ghostTextContent = remainingPart;
        
        // Add any following words from the completion
        const followingWords = completion.split(' ').slice(1).join(' ');
        if (followingWords) {
          ghostTextContent += ' ' + followingWords;
        }
      } else {
        // Add space if needed
        const needsSpace = !cursorHasSpace && textBeforeCursor.trim().length > 0;
        ghostTextContent = (needsSpace ? ' ' : '') + completion;
      }
    } else {
      // Add space if needed
      const needsSpace = !cursorHasSpace && textBeforeCursor.trim().length > 0;
      ghostTextContent = (needsSpace ? ' ' : '') + completion;
    }

    // Don't show empty ghost text
    if (!ghostTextContent.trim()) {
      if (debug) {
        console.log('ComposeAI: Ghost text creation cancelled - Empty content');
      }
      return null;
    }
    
    ghostText.textContent = ghostTextContent;
    
    // Copy relevant styles from the input
    const stylesToCopy = [
      'font-family',
      'font-size',
      'font-weight',
      'line-height',
      'letter-spacing',
      'text-transform',
      'word-spacing'
    ];

    stylesToCopy.forEach(style => {
      ghostText.style[style] = computedStyle[style];
    });

    // Position the ghost text
    const rect = activeElement.getBoundingClientRect();
    
    // Create a temporary span to measure text width
    const measureSpan = document.createElement('span');
    measureSpan.style.visibility = 'hidden';
    measureSpan.style.position = 'absolute';
    measureSpan.style.whiteSpace = 'pre';
    stylesToCopy.forEach(style => {
      measureSpan.style[style] = computedStyle[style];
    });
    measureSpan.textContent = textBeforeCursor;
    document.body.appendChild(measureSpan);
    
    // Calculate position
    const textWidth = measureSpan.getBoundingClientRect().width;
    measureSpan.remove();

    // Account for padding in input elements
    const style = window.getComputedStyle(activeElement);
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    
    const leftOffset = activeElement.isContentEditable ? 
      rect.left : 
      rect.left + paddingLeft + borderLeft;
    
    // Position the ghost text
    ghostText.style.position = 'absolute';
    ghostText.style.zIndex = '999998';
    ghostText.style.pointerEvents = 'none';
    ghostText.style.whiteSpace = 'pre';
    ghostText.style.top = `${rect.top + window.scrollY}px`;
    ghostText.style.left = `${leftOffset + textWidth}px`;
    
    // Add to DOM
    document.body.appendChild(ghostText);
    currentGhostText = ghostText;

    // Apply dark mode if needed
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      ghostText.classList.add('dark-mode');
    }

    return ghostText;
  } catch (error) {
    console.log('ComposeAI: Error creating ghost text:', error);
    return null;
  }
}

// Remove ghost text safely
function removeGhostText() {
  if (currentGhostText) {
    try {
      currentGhostText.remove();
    } catch (e) {
      console.log('ComposeAI: Error removing ghost text:', e);
    }
    currentGhostText = null;
  }
}

// Add tooltip keyboard event handler
function addTooltipKeydownHandler(tooltip, completion, lastWord) {
  try {
    function keydownHandler(e) {
      if (e.key === 'Tab') {
        e.preventDefault();
        handleCompletion(completion, lastWord);
        tooltip.remove();
        resetSuggestionState();
      } else if (e.key >= '1' && e.key <= '3' && tooltip.querySelectorAll('.compose-alt-item').length >= parseInt(e.key)) {
        e.preventDefault();
        const altItem = tooltip.querySelectorAll('.compose-alt-item')[parseInt(e.key) - 1];
        const altText = altItem.dataset.text;
        handleCompletion(altText, lastWord);
        tooltip.remove();
        resetSuggestionState();
      } else if (e.key === 'Escape' || e.key === 'Enter') {
        tooltip.remove();
        resetSuggestionState();
      }
    }

    document.addEventListener('keydown', keydownHandler);

    // Click handlers for alternatives
    tooltip.querySelectorAll('.compose-alt-item').forEach(item => {
      item.addEventListener('click', () => {
        const index = parseInt(item.dataset.index);
        const altText = item.dataset.text;
        if (!isNaN(index) && altText) {
          handleCompletion(altText, lastWord);
          tooltip.remove();
          resetSuggestionState();
        }
      });
    });

    // Remove event listener when tooltip is removed
    const tooltipObserver = new MutationObserver((mutations) => {
      if (!document.body.contains(tooltip)) {
        document.removeEventListener('keydown', keydownHandler);
        tooltipObserver.disconnect();
      }
    });

    tooltipObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
} catch (error) {
    console.log('ComposeAI: Error adding tooltip keydown handler:', error);
  }
}

// Listen for messages with error handling
try {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // First, immediately send a response to prevent "channel closed" errors
    // This is the key fix for the "message channel closed" error
    sendResponse({ received: true });
    
    // Reset disconnected flag if we receive a message
    isExtensionDisconnected = false;
    reconnectionAttempts = 0;
    
    // Process messages as normal...
    if (request.type === 'PING_RESPONSE') {
      console.log('ComposeAI: Connection confirmed');
      return;
    }
    
    if (request.type === 'LOG_MESSAGE') {
      const prefix = 'ComposeAI:';
      switch (request.level) {
        case 'error':
          console.error(prefix, request.message, request.data);
          break;
        case 'warn':
          console.warn(prefix, request.message, request.data);
          break;
        case 'info':
        default:
          console.log(prefix, request.message, request.data);
          break;
      }
      return;
    }

    if (request.type !== 'COMPLETION_RECEIVED' || !activeElement) {
      return;
    }

    // Process completion as normal...
    if (request.error) {
      console.error('ComposeAI: Error received:', request.error);
      const errorTooltip = createTooltip(request.error, false, true);
      if (errorTooltip) {
        document.querySelectorAll('.compose-tooltip').forEach(t => t.remove());
        positionTooltip(errorTooltip, activeElement);
        setTimeout(() => {
          if (errorTooltip && document.body.contains(errorTooltip)) {
            errorTooltip.remove();
          }
        }, 3000);
      }
      return;
    }

    if (request.completion) {
      // Check if ghost text mode is enabled
      if (settings.useGhostText) {
        removeGhostText(); // Clear any existing ghost text
        const ghostText = createGhostText(request.completion, request.lastWord, request.completion);
        if (ghostText) {
          // Store the current suggestion for future reference
          currentSuggestion = request.completion;
          currentLastWord = request.lastWord;
          
          // Remove any existing tooltips
          document.querySelectorAll('.compose-tooltip').forEach(t => {
            console.log('ComposeAI: Tooltip removed - Switching to ghost text');
            t.remove();
          });

          // Add keyboard event listener for ghost text
          function ghostKeydownHandler(e) {
            if (e.key === 'Tab') {
              e.preventDefault();
              
              // Get the current state
              const content = getEditorContent(activeElement);
              const cursorPos = getCursorPosition(activeElement);
              const textBeforeCursor = content.slice(0, cursorPos);
              const currentWordMatch = textBeforeCursor.match(/\S+$/);
              const currentWord = currentWordMatch ? currentWordMatch[0] : '';
              
              // Always use the full completion text
              handleCompletion(request.completion, currentWord || request.lastWord, request.completion);
              
              console.log('ComposeAI: Ghost text removed - Tab key pressed');
              removeGhostText();
              resetSuggestionState();
            } else if (e.key === 'Escape' || e.key === 'Enter') {
              console.log('ComposeAI: Ghost text removed - Escape/Enter pressed');
              removeGhostText();
              resetSuggestionState();
            }
          }

          document.addEventListener('keydown', ghostKeydownHandler);

          // Remove event listener when ghost text is removed
          const ghostObserver = new MutationObserver((mutations) => {
            if (!document.body.contains(ghostText)) {
              document.removeEventListener('keydown', ghostKeydownHandler);
              ghostObserver.disconnect();
            }
          });

          ghostObserver.observe(document.body, {
            childList: true,
            subtree: true
          });
        }
      } else {
        // Original tooltip behavior
        const tooltip = createTooltip(request.completion, false, false, request.alternatives);
        if (tooltip) {
          // Remove existing tooltips
          document.querySelectorAll('.compose-tooltip').forEach(t => {
            console.log('ComposeAI: Tooltip removed - New completion received');
            t.remove();
          });
          removeGhostText();
          positionTooltip(tooltip, activeElement);

          // Store the full suggestion for reference
          currentSuggestion = request.completion;
          currentLastWord = request.lastWord;
          
          // Add tooltip keyboard event handlers
          addTooltipKeydownHandler(tooltip, request.completion, request.alternatives);
        } else {
          console.log('ComposeAI: No tooltip created - No remaining text to show');
        }
      }
    }

    // Don't return true here - we already sent the response synchronously
    return false;
  });
} catch (error) {
  console.log('ComposeAI: Error setting up message listener:', error);
  isExtensionDisconnected = true;
  scheduleReconnection();
}

/* Helper utility functions */

// Helper function to get input label text
function getInputLabel(input) {
  try {
    // Check for aria-label
    if (input.getAttribute('aria-label')) {
      return input.getAttribute('aria-label');
    }
    
    // Check for associated label element
    const id = input.id;
    if (id) {
      const label = document.querySelector(`label[for="${id}"]`);
      if (label) {
        return label.textContent;
      }
    }
    
    // Check for parent label
    const parentLabel = input.closest('label');
    if (parentLabel) {
      return parentLabel.textContent;
    }
    
    // Check for preceding label or text
    const previousElement = input.previousElementSibling;
    if (previousElement && (previousElement.tagName === 'LABEL' || previousElement.tagName === 'SPAN')) {
      return previousElement.textContent;
    }
    
    return '';
  } catch (error) {
    console.log('ComposeAI: Error getting input label:', error);
    return '';
  }
}

// Helper function to get nearby text content
function getNearbyText(element, maxDistance = 300) {
  try {
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    // Get all text nodes within the viewport
    const textNodes = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );

    let node;
    while (node = walker.nextNode()) {
      const nodeRect = node.parentElement.getBoundingClientRect();
      const nodeCenterX = nodeRect.left + nodeRect.width / 2;
      const nodeCenterY = nodeRect.top + nodeRect.height / 2;
      
      // Calculate distance
      const distance = Math.sqrt(
        Math.pow(centerX - nodeCenterX, 2) + 
        Math.pow(centerY - nodeCenterY, 2)
      );
      
      if (distance <= maxDistance) {
        const text = node.textContent.trim();
        if (text.length > 0) {
          textNodes.push({
            text: text,
            distance: distance
          });
        }
      }
    }
    
    // Sort by distance and return concatenated text
    return textNodes
      .sort((a, b) => a.distance - b.distance)
      .map(node => node.text)
      .join(' ');
  } catch (error) {
    console.log('ComposeAI: Error getting nearby text:', error);
    return '';
  }
}

// Check if element is a valid input field
function isValidInputField(element) {
  try {
    if (!element) return false;

    // Basic input types
    if (element instanceof HTMLInputElement) {
      const validTypes = ['text', 'search', 'url', 'email', 'tel'];
      return validTypes.includes(element.type.toLowerCase());
    }

    // Textarea
    if (element instanceof HTMLTextAreaElement) {
      return true;
    }

    // Contenteditable elements
    if (element.isContentEditable) {
      return true;
    }

    // Monaco editor (VS Code-like editors)
    if (element.classList && element.classList.contains('monaco-editor')) {
      return true;
    }

    // CodeMirror editor
    if (element.classList && element.classList.contains('CodeMirror')) {
      return true;
    }

    // Check for common rich text editor frameworks
    const editorClasses = [
      'ql-editor', // Quill
      'ProseMirror', // ProseMirror
      'tox-edit-area', // TinyMCE
      'cke_editable', // CKEditor
      'ace_editor', // Ace Editor
      'froala-editor' // Froala
    ];

    return element.classList && editorClasses.some(className => element.classList.contains(className));
  } catch (error) {
    console.log('ComposeAI: Error checking valid input field:', error);
    return false;
  }
}

// Get text content from different types of editors
function getEditorContent(element) {
  try {
    if (!element) return '';

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return element.value;
    }

    if (element.isContentEditable) {
      return element.textContent;
    }

    // Handle different editor frameworks
    if (element.classList && element.classList.contains('monaco-editor')) {
      const model = element.querySelector('.monaco-editor')?.['_modelData']?.['model'];
      return model ? model.getValue() : '';
    }

    if (element.classList && element.classList.contains('CodeMirror')) {
      return element.CodeMirror?.getValue() || '';
    }

    // Default to textContent
    return element.textContent || '';
  } catch (error) {
    console.log('ComposeAI: Error getting editor content:', error);
    return '';
  }
}

// Get cursor position from different types of editors
function getCursorPosition(element) {
  try {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return element.selectionStart;
    }

    if (element.isContentEditable) {
      const selection = window.getSelection();
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        return range.startOffset;
      }
    }

    // Handle different editor frameworks
    if (element.classList && element.classList.contains('monaco-editor')) {
      const model = element.querySelector('.monaco-editor')?.['_modelData']?.['model'];
      const position = model?.getPosition();
      return position ? model.getOffsetAt(position) : 0;
    }

    if (element.classList && element.classList.contains('CodeMirror')) {
      const cm = element.CodeMirror;
      if (cm) {
        const pos = cm.getCursor();
        return cm.indexFromPos(pos);
      }
    }

    return 0;
  } catch (error) {
    console.log('ComposeAI: Error getting cursor position:', error);
    return 0;
  }
}

// Try to reconnect periodically if disconnected
setInterval(() => {
  if (isExtensionDisconnected) {
    initializeExtension();
  }
}, 60000); // Check every minute