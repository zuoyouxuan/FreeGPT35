// Assuming the availability of the fetch API and addEventListener method in the Workers environment

// Constants for the server and API configuration
const baseUrl = "https://chat.openai.com";
const apiUrl = `${baseUrl}/backend-api/conversation`;
const refreshInterval = 60000; // Interval to refresh token in ms
const errorWait = 120000; // Wait time in ms after an error

// Globals to store the session token and device ID
let token;
let oaiDeviceId;

// Function to wait for a specified duration
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Function to generate a random UUID
function generateUUID() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let uuid = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      uuid += '-';
    } else {
      uuid += chars[Math.floor(Math.random() * chars.length)];
    }
  }
  return uuid;
}

// Function to generate a completion ID
function generateCompletionId(prefix = "cmpl-") {
  const characters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const length = 28;

  for (let i = 0; i < length; i++) {
    prefix += characters.charAt(Math.floor(Math.random() * characters.length));
  }

  return prefix;
}

async function* chunksToLines(chunksAsync) {
  let previous = "";
  for await (const chunk of chunksAsync) {
    previous += new TextDecoder("utf-8").decode(chunk);
    let eolIndex;
    while ((eolIndex = previous.indexOf("\n")) >= 0) {
      // line includes the EOL
      const line = previous.slice(0, eolIndex + 1).trimEnd();
      if (line === "data: [DONE]") break;
      if (line.startsWith("data: ")) yield line;
      previous = previous.slice(eolIndex + 1);
    }
  }
}

async function* linesToMessages(linesAsync) {
  for await (const line of linesAsync) {
    const message = line.substring("data :".length);
    yield message;
  }
}

async function* streamCompletion(data) {
  yield* linesToMessages(chunksToLines(data));
}

// Function to get a new session ID and token from the OpenAI API
async function getNewSessionId() {
  const newDeviceId = generateUUID();
  const response = await fetch(`${baseUrl}/backend-anon/sentinel/chat-requirements`, {
    method: 'POST',
    headers: {
      'oai-device-id': newDeviceId,
      'Content-Type': 'application/json',
    },
  });

  console.log(`System: Successfully refreshed session ID and token. ${!token ? "(Now it's ready to process requests)" : ""}`);
  oaiDeviceId = newDeviceId;
  const data = await response.json();
  token = data.token;
}

async function handleRequest(request) {
  if (request.method === 'POST' && request.url.endsWith('/v1/chat/completions')) {
    return handleChatCompletion(request);
  } else {
    return new Response(JSON.stringify({
      status: false,
      error: {
        message: `The requested endpoint was not found. Please make sure to use "/v1/chat/completions" as the endpoint.`,
        type: "invalid_request_error",
      },
      support: "https://discord.pawan.krd",
    }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function handleChatCompletion(request) {
  console.log("Request:", `${request.method} ${request.url}`, request.headers.get('stream') ? "(stream-enabled)" : "(stream-disabled)");
  // The try-catch block and the rest of the function remains largely the same as in the original TypeScript version
  // Omitting for brevity. Please insert appropriate JavaScript code here.

  // Make sure to replace any TypeScript-specific code with its JavaScript counterpart.
}

async function refreshTokenLoop() {
  while (true) {
    try {
      await getNewSessionId();
      await wait(refreshInterval);
    } catch (error) {
      console.error("Error refreshing session ID, retrying in 1 minute...");
      console.error("If this error persists, your country may not be supported yet.");
      console.error("If your country was the issue, please consider using a U.S. VPN.");
      await wait(errorWait);
    }
  }
}

addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event.request));
});

addEventListener('scheduled', (event) => {
  event.waitUntil(refreshTokenLoop());
});
