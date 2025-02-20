import {
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory
} from '@google/generative-ai';

// Do not expose API key in production
const apiKey = 'YOUR_API_KEY';

let genAI = null;
let model = null;
let lastRequestTime = 0;
const DEBOUNCE_TIME = 300; // ms

const textArea = document.querySelector('#input-text');
const completionText = document.querySelector('#completion-text');
const errorElement = document.querySelector('#error');

function initModel() {
  const safetySettings = [
    {
      category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
      threshold: HarmBlockThreshold.BLOCK_NONE
    }
  ];
  
  genAI = new GoogleGenerativeAI(apiKey);
  model = genAI.getGenerativeModel({
    model: 'gemini-pro',
    generationConfig: {
      maxOutputTokens: 50,
      temperature: 0.4,
      topK: 40,
      topP: 0.8,
    },
    safetySettings
  });
  return model;
}

async function getCompletion(text) {
  if (!text.trim()) {
    completionText.textContent = '';
    return;
  }

  try {
    showLoading();
    const prompt = `Complete this sentence naturally: "${text}"`;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const completion = response.text();
    
    // Remove quotes and get only the new text
    const cleanedCompletion = completion.replace(/['"]/g, '');
    const newTextOnly = cleanedCompletion.slice(text.length);
    
    showCompletion(text + newTextOnly);
  } catch (e) {
    showError(e);
  }
}

function debounce(func, text) {
  const now = Date.now();
  if (now - lastRequestTime >= DEBOUNCE_TIME) {
    lastRequestTime = now;
    func(text);
  }
}

textArea.addEventListener('input', (e) => {
  const text = e.target.value;
  debounce(getCompletion, text);
});

// Handle Tab key to accept completion
textArea.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && completionText.textContent) {
    e.preventDefault();
    textArea.value = completionText.textContent;
    completionText.textContent = '';
  }
});

function showLoading() {
  hideError();
  completionText.textContent = '...';
}

function showCompletion(text) {
  completionText.textContent = text;
}

function showError(error) {
  errorElement.textContent = error.message;
  errorElement.removeAttribute('hidden');
}

function hideError() {
  errorElement.setAttribute('hidden', '');
}

// Initialize the model when the page loads
initModel();

// import {
//   GoogleGenerativeAI,
//   HarmBlockThreshold,
//   HarmCategory
// } from '../node_modules/@google/generative-ai/dist/index.mjs';

// // Important! Do not expose your API in your extension code. You have to
// // options:
// //
// // 1. Let users provide their own API key.
// // 2. Manage API keys in your own server and proxy all calls to the Gemini
// // API through your own server, where you can implement additional security
// // measures such as authentification.
// //
// // It is only OK to put your API key into this file if you're the only
// // user of your extension or for testing.
// const apiKey = 'AIzaSyCE8d4bHtEthf2KHKGUxh-KNhxUo8hWASI';

// let genAI = null;
// let model = null;
// let generationConfig = {
//   temperature: 1
// };

// const inputPrompt = document.body.querySelector('#input-prompt');
// const buttonPrompt = document.body.querySelector('#button-prompt');
// const elementResponse = document.body.querySelector('#response');
// const elementLoading = document.body.querySelector('#loading');
// const elementError = document.body.querySelector('#error');
// const sliderTemperature = document.body.querySelector('#temperature');
// const labelTemperature = document.body.querySelector('#label-temperature');

// function initModel(generationConfig) {
//   const safetySettings = [
//     {
//       category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
//       threshold: HarmBlockThreshold.BLOCK_NONE
//     }
//   ];
//   genAI = new GoogleGenerativeAI(apiKey);
//   model = genAI.getGenerativeModel({
//     model: 'gemini-1.5-flash',
//     safetySettings,
//     generationConfig
//   });
//   return model;
// }

// async function runPrompt(prompt) {
//   try {
//     const result = await model.generateContent(prompt);
//     const response = await result.response;
//     return response.text();
//   } catch (e) {
//     console.log('Prompt failed');
//     console.error(e);
//     console.log('Prompt:', prompt);
//     throw e;
//   }
// }

// sliderTemperature.addEventListener('input', (event) => {
//   labelTemperature.textContent = event.target.value;
//   generationConfig.temperature = event.target.value;
// });

// inputPrompt.addEventListener('input', () => {
//   if (inputPrompt.value.trim()) {
//     buttonPrompt.removeAttribute('disabled');
//   } else {
//     buttonPrompt.setAttribute('disabled', '');
//   }
// });

// buttonPrompt.addEventListener('click', async () => {
//   const prompt = inputPrompt.value.trim();
//   showLoading();
//   try {
//     const generationConfig = {
//       temperature: sliderTemperature.value
//     };
//     initModel(generationConfig);
//     const response = await runPrompt(prompt, generationConfig);
//     showResponse(response);
//   } catch (e) {
//     showError(e);
//   }
// });

// function showLoading() {
//   hide(elementResponse);
//   hide(elementError);
//   show(elementLoading);
// }

// function showResponse(response) {
//   hide(elementLoading);
//   show(elementResponse);
//   // Make sure to preserve line breaks in the response
//   elementResponse.textContent = '';
//   const paragraphs = response.split(/\r?\n/);
//   for (let i = 0; i < paragraphs.length; i++) {
//     const paragraph = paragraphs[i];
//     if (paragraph) {
//       elementResponse.appendChild(document.createTextNode(paragraph));
//     }
//     // Don't add a new line after the final paragraph
//     if (i < paragraphs.length - 1) {
//       elementResponse.appendChild(document.createElement('BR'));
//     }
//   }
// }

// function showError(error) {
//   show(elementError);
//   hide(elementResponse);
//   hide(elementLoading);
//   elementError.textContent = error;
// }

// function show(element) {
//   element.removeAttribute('hidden');
// }

// function hide(element) {
//   element.setAttribute('hidden', '');
// }
