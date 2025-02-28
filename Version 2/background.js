"use strict";

let timer = null;
let textBoxContent = '';
const API_URL = 'https://api.openai.com/v1/chat/completions';
const debug = true;

// Global tab map to keep track of active connections
const activeTabs = new Map();

// Schema for structured completion output
const completionSchema = {
  type: "object",
  properties: {
    completion: {
      type: "string",
      description: "The primary completion suggestion that continues naturally from the user's input"
    },
    lastWord: {
      type: "string",
      description: "The last complete word that this completion is continuing from"
    },
    alternatives: {
      type: "array",
      items: { type: "string" },
      description: "List of alternative completion suggestions"
    },
    confidence: {
      type: "number",
      description: "Confidence score between 0 and 1 for the primary completion"
    }
  },
  required: ["completion", "lastWord", "alternatives", "confidence"]
};

// Safely send messages to content script with error handling
async function sendMessageToContentScript(tabId, message) {
  if (!tabId) {
    console.error('ComposeAI: Cannot send message - invalid tab ID');
    return;
  }
  
  try {
    // Check if tab still exists before sending message
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      console.log(`ComposeAI: Tab ${tabId} no longer exists`);
      activeTabs.delete(tabId);
      return;
    }
    
    // Use a timeout to prevent hanging
    const sendPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.log(`ComposeAI: Message sending timed out for tab ${tabId}`);
        resolve(); // Resolve with undefined instead of rejecting to prevent error cascade
      }, 5000);
      
      try {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError) {
            console.log('ComposeAI: Error sending message to content script:', chrome.runtime.lastError);
            resolve(); // Resolve with undefined instead of rejecting
          } else {
            resolve(response);
          }
        });
      } catch (e) {
        clearTimeout(timeout);
        console.log('ComposeAI: Exception sending message:', e);
        resolve(); // Resolve with undefined instead of rejecting
      }
    });
    
    await sendPromise;
  } catch (error) {
    console.log('ComposeAI: Error in sendMessageToContentScript:', error);
    // We don't need to rethrow the error - just log it
  }
}

async function generateCompletions(request, sender) {
  try {
    if (debug) console.log('ComposeAI: Processing text update request');
    textBoxContent = request.textBoxContent;
    const cursorPosition = request.cursorPosition || textBoxContent.length;
    
    // Validate sender information
    if (!sender || !sender.tab || !sender.tab.id) {
      console.error('ComposeAI: Invalid sender information:', sender);
      return;
    }
    
    const tabId = sender.tab.id;
    activeTabs.set(tabId, Date.now()); // Track this tab as active
    
    // Get settings from storage
    const settings = await chrome.storage.sync.get({
      apiKey: '',
      modelTemp: 0.7,
      debounceTime: 0.3,
      useGhostText: true,
      isEnabled: true
    });
    
    // Check API key
    if (!settings.apiKey) {
      throw new Error('API key not configured. Please set up your OpenAI API key in the extension options.');
    }

    // Use the context sent with the request
    const context = request.context || {};

    // Build context text
    const context_text = `
    PAGE TITLE: ${context.title || ''}
    PAGE DESCRIPTION: ${context.description || ''}
    CURRENT FORM CONTEXT: ${context.formContext || ''}
    NEARBY TEXT: ${context.nearbyContext || ''}
    PAGE HEADINGS: ${context.headings || ''}
    INPUT FIELD INFO:
      - Label: ${context.inputContext?.label || ''}
      - Placeholder: ${context.inputContext?.placeholder || ''}
      - Field Name: ${context.inputContext?.name || ''}
      - Field Type: ${context.inputContext?.type || ''}
    `;

    if (debug) console.log('ComposeAI: Built context text');

    // Analyze the current text and cursor position
    const textBeforeCursor = textBoxContent.slice(0, cursorPosition);
    const words = textBeforeCursor.split(/\s+/);
    const lastWord = textBeforeCursor.match(/\S+$/)?.[0] || '';
    const isPartialWord = lastWord && !textBeforeCursor.endsWith(' ');

    // Send request to OpenAI API
    if (debug) console.log('ComposeAI: Sending API request');
    
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify({
        'model': 'gpt-4o-mini', // Default model
        'messages': [
          {
            "role": "system",
            "content": `You are an AI writing assistant that helps complete text as the user types. Your goal is to understand the writer's intent and provide intuitive, natural-sounding completions that feel like what they were about to type.

IMPORTANT: You must ONLY respond with a JSON object in this exact format:
{
  "completion": "your primary completion suggestion",
  "lastWord": "Return the final complete word from the original text that the continuation is based on. If the continuation is only a fragment of a word, return an empty string.",
  "alternatives": ["alternative1", "alternative2", "alternative3"],
  "confidence": 0.9
}

Guidelines:
1. Analyze the full context, including previous sentences, page title, and form fields to understand what the user is communicating
2. Prioritize completions that match the user's writing style, vocabulary level, and tone
3. For inputs like emails, messages, or forms, consider the appropriate language patterns and conventions
4. Keep completions concise (2-7 words) and immediately useful
5. Alternatives should offer meaningfully different directions, not minor variations
6. Provide higher confidence scores (0.8-0.95) when the context strongly suggests a specific completion
7. Lower confidence scores (0.3-0.7) for more open-ended or ambiguous contexts
8. Consider input field purpose (e.g., email subject vs. message body) when generating completions
9. For lastWord: When completing a partial word (e.g. "pre" becoming "predict"), return an empty string ("")
10. For lastWord: When starting a new word after a complete word, return that complete word
Content-specific guidelines:
- For emails: Match formal/informal tone appropriately. In email subjects, provide concise, clear completions.
- For social media: Offer more casual, conversational completions.
- For forms: Prioritize factual, concise information based on field labels.
- For creative writing: Suggest more evocative, descriptive completions.
- For technical content: Focus on accuracy and domain-specific terminology.
- For chat/messaging: Prioritize conversational completions that would naturally continue the dialogue.
Word completion strategy:
- For partial words with clear intent (e.g., "unfort" -> "unfortunately"), complete with high confidence
- For ambiguous partials (e.g., "pro" could be "problem", "process", "provide"), offer diverse alternatives
- Consider word frequency in context - suggest common words in that specific domain
- For acronyms or technical terms, check nearby text for clues about domain
When analyzing context, consider:
- Document title and headings for overall topic
- Previously typed sentences for subject matter and tone
- Input field labels and nearby text for expected content
- Surrounding form fields for context (e.g., if filling address fields, suggest address-related completions)
- Recent user interactions to maintain consistency
Debug feature (optional - remove in production):
Add a "_reasoning" field explaining why this completion was chosen, e.g.:
"_reasoning": "Suggested 'unfortunately' because user is writing in formal tone and previous sentences indicate explaining a problem"`
          },
          {
            "role": "user",
            "content": `Webpage context:
${context_text}

The user is typing (| is cursor): "${textBeforeCursor}|${textBoxContent.slice(cursorPosition)}"
Current text: "${textBoxContent}"
Last word being typed: "${lastWord}"
Is partial word: ${isPartialWord}

Based on this context, provide completion suggestions that naturally continue from the current text.`
          }
        ],
        'temperature': parseFloat(settings.modelTemp) || 0.7,
        'max_tokens': 150
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      console.error('ComposeAI: API request failed:', errorData);
      throw new Error(errorData.error?.message || 'API request failed. Please try again.');
    }
    
    if (debug) console.log('ComposeAI: Received API response');
    
    const data = await response.json();
    let result;

    try {
      // Parse the AI response as JSON
      const rawResponse = data.choices[0].message.content;
      result = JSON.parse(rawResponse);
      
      // Send parsed response to content script for logging if in debug mode
      if (debug) {
        await sendMessageToContentScript(tabId, {
          type: 'LOG_MESSAGE',
          level: 'info',
          message: 'Parsed AI Response:',
          data: result
        });
      }
      
    } catch (e) {
      console.error('ComposeAI: Failed to parse response as JSON:', e);
      
      // If parsing fails, use the raw completion
      result = {
        completion: data.choices[0].message.content.trim(),
        alternatives: [],
        confidence: 0.5,
        lastWord: lastWord
      };
    }

    if (!result.completion || result.completion.trim().length === 0) {
      console.log('ComposeAI: No meaningful completion generated');
      return;
    }

    // Clean up the completion
    let completion = result.completion.trim();
    
    // Handle partial words correctly
    if (isPartialWord) {
      const currentWordMatch = textBoxContent.match(/\S+$/);
      const currentWord = currentWordMatch ? currentWordMatch[0] : '';
      
      // Check if the completion is completing the current word
      const isCompletingWord = completion.toLowerCase().startsWith(currentWord.toLowerCase());

      if (isCompletingWord) {
        // If completion already includes the partial word, just keep it
        if (completion.toLowerCase().startsWith(currentWord.toLowerCase())) {
          // Keep completion as is
        } else {
          // Remove leading spaces and combine with current word
          completion = completion.replace(/^\s*/, '');
          if (completion && !completion.match(/^\W/)) {
            completion = currentWord + completion.slice(currentWord.length);
          }
        }
      } else {
        // If it's a new word, just use the completion as is
        completion = completion.trim();
      }
    }

    // Clean up alternatives
    const alternatives = (result.alternatives || []).map(alt => {
      let cleaned = alt.trim();
      if (isPartialWord) {
        const currentWord = textBoxContent.match(/\S+$/)?.[0] || '';
        
        // Apply the same word completion logic to alternatives
        const isCompletingWord = cleaned.toLowerCase().startsWith(currentWord.toLowerCase());

        if (isCompletingWord) {
          if (cleaned.toLowerCase().startsWith(currentWord.toLowerCase())) {
            // Keep the alternative as is
          } else {
            // Remove any leading spaces and combine
            cleaned = cleaned.replace(/^\s*/, '');
            if (cleaned && !cleaned.match(/^\W/)) {
              cleaned = currentWord + cleaned.slice(currentWord.length);
            }
          }
        } else {
          // If it's a new word, just use it as is
          cleaned = cleaned.trim();
        }
      }
      return cleaned;
    }).filter(alt => 
      alt !== completion && 
      alt.length > 0 && 
      alt.trim() !== lastWord &&
      alt.toLowerCase() !== lastWord.toLowerCase()
    );

    // Ensure we have unique alternatives (up to 3)
    const uniqueAlternatives = [...new Set(alternatives)]
      .filter(alt => alt && alt.trim().length > 0)
      .slice(0, 3);
    
    // Send final completion to content script
    await sendMessageToContentScript(tabId, {
      type: 'COMPLETION_RECEIVED',
      completion: completion,
      alternatives: uniqueAlternatives,
      confidence: result.confidence || 0.8,
      lastWord: result.lastWord || '',
      partialWord: lastWord,
      originalLength: textBoxContent.length
    });
    
    if (debug) console.log('ComposeAI: Completion sent to content script successfully');
    
  } catch (error) {
    console.error('ComposeAI Error:', error);
    
    // Only attempt to send error message if we have a valid sender
    if (sender && sender.tab && sender.tab.id) {
      try {
        await sendMessageToContentScript(
          sender.tab.id,
          {
            type: 'COMPLETION_RECEIVED',
            error: error.message || 'An unknown error occurred'
          }
        );
      } catch (sendError) {
        console.error('ComposeAI: Error sending error message to content script:', sendError);
      }
    }
  }
}

// Listen for messages from the content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Always respond immediately to prevent connection hanging
  sendResponse({ received: true });
  
  // Handle PING messages for connection checking
  if (request.type === 'PING') {
    if (sender && sender.tab && sender.tab.id) {
      if (debug) console.log(`ComposeAI: Received ping from tab ${sender.tab.id}`);
      
      sendMessageToContentScript(sender.tab.id, {
        type: 'PING_RESPONSE'
      });
    }
    return;
  }
  
  if (request.type === 'TEXT_BOX_UPDATED') {
    if (debug) console.log('ComposeAI: Received text box update');
    
    // Skip if user hasn't typed since last completion
    if (request.hasTypedSinceCompletion === false) {
      console.log('ComposeAI: Skipping update - no typing since last completion');
      return;
    }
    
    if (timer) {
      clearTimeout(timer);
    }
    
    timer = setTimeout(() => {
      generateCompletions(request, sender);
    }, 300);
  } else if (request.type === 'STORE_CONTEXT') {
    console.log('ComposeAI: Storing new context');
    chrome.storage.local.set({context: request.context});
  }
  
  // We already sent a synchronous response, don't return true here
  return false;
});

// Handle extension startup
chrome.runtime.onStartup.addListener(() => {
  console.log('ComposeAI: Extension started');
});

// Optional: Handle tab closures to clean up activeTabs map
chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeTabs.has(tabId)) {
    activeTabs.delete(tabId);
    console.log(`ComposeAI: Tab ${tabId} closed, removed from active tabs`);
  }
});

// Optional: Periodic cleanup of activeTabs that haven't been active recently
setInterval(() => {
  const now = Date.now();
  const staleTimeout = 30 * 60 * 1000; // 30 minutes
  
  for (const [tabId, lastActive] of activeTabs.entries()) {
    if (now - lastActive > staleTimeout) {
      activeTabs.delete(tabId);
      console.log(`ComposeAI: Removed stale tab ${tabId} from active tabs`);
    }
  }
}, 15 * 60 * 1000); // Run cleanup every 15 minutes