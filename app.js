import { Request, Response } from '@cloudflare/workers-types';

// Constants for the server and API configuration
const baseUrl = "https://chat.openai.com";
const apiUrl = `${baseUrl}/backend-api/conversation`;
const refreshInterval = 60000; // Interval to refresh token in ms
const errorWait = 120000; // Wait time in ms after an error

// Initialize global variables to store the session token and device ID
let token: string;
let oaiDeviceId: string;

// Function to wait for a specified duration
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
function generateCompletionId(prefix: string = "cmpl-") {
  const characters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const length = 28;

  for (let i = 0; i < length; i++) {
    prefix += characters.charAt(Math.floor(Math.random() * characters.length));
  }

  return prefix;
}

async function* chunksToLines(chunksAsync: ReadableStream<Uint8Array>) {
  let previous = "";
  for await (const chunk of chunksAsync) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    previous += bufferChunk;
    let eolIndex: number;
    while ((eolIndex = previous.indexOf("\n")) >= 0) {
      // line includes the EOL
      const line = previous.slice(0, eolIndex + 1).trimEnd();
      if (line === "data: [DONE]") break;
      if (line.startsWith("data: ")) yield line;
      previous = previous.slice(eolIndex + 1);
    }
  }
}

async function* linesToMessages(linesAsync: AsyncIterable<string>) {
  for await (const line of linesAsync) {
    const message = line.substring("data :".length);

    yield message;
  }
}

async function* StreamCompletion(data: ReadableStream<Uint8Array>) {
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
  token = await response.json().then(data => data.token);
}

async function handleRequest(request: Request): Promise<Response> {
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

async function handleChatCompletion(request: Request): Promise<Response> {
  console.log("Request:", `${request.method} ${request.url}`, request.headers.get('stream') ? "(stream-enabled)" : "(stream-disabled)");
  try {
    const body = await request.json();
    const requestBody = {
      action: "next",
      messages: body.messages.map((message: any) => ({
        author: { role: message.role },
        content: { content_type: "text", parts: [message.content] },
      })),
      parent_message_id: generateUUID(),
      model: "text-davinci-002-render-sha",
      timezone_offset_min: -180,
      suggestions: [],
      history_and_training_disabled: true,
      conversation_mode: { kind: "primary_assistant" },
      websocket_request_id: generateUUID(),
    };

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'oai-device-id': oaiDeviceId,
        'openai-sentinel-chat-requirements-token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    const contentType = request.headers.get('stream') ? "text/event-stream" : "application/json";
    const headers = {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    };

    let fullContent = "";
    let requestId = generateCompletionId("chatcmpl-");
    let created = Date.now();

    if (request.headers.get('stream')) {
      const stream = new ReadableStream({
        async start(controller) {
          for await (const message of StreamCompletion(response.body!)) {
            const parsed = JSON.parse(message);

            let content = parsed?.message?.content?.parts[0] ?? "";

            for (let message of body.messages) {
              if (message.content === content) {
                content = "";
                break;
              }
            }

            if (content === "") continue;

            let response = {
              id: requestId,
              created: created,
              object: "chat.completion.chunk",
              model: "gpt-3.5-turbo",
              choices: [
                {
                  delta: {
                    content: content.replace(fullContent, ""),
                  },
                  index: 0,
                  finish_reason: null,
                },
              ],
            };

            controller.enqueue(`data: ${JSON.stringify(response)}\n\n`);
            fullContent = content.length > fullContent.length ? content : fullContent;
          }

          controller.enqueue(`data: ${JSON.stringify({
            id: requestId,
            created: created,
            object: "chat.completion.chunk",
            model: "gpt-3.5-turbo",
            choices: [
              {
                delta: {
                  content: "",
                },
                index: 0,
                finish_reason: "stop",
              },
            ],
          })}\n\n`);
          controller.close();
        },
      });

      return new Response(stream, { headers });
    } else {
      let text = "";
      for await (const message of StreamCompletion(response.body!)) {
        const parsed = JSON.parse(message);
        let content = parsed?.message?.content?.parts[0] ?? "";
        text += content;
      }

      const responseBody = JSON.stringify({
        id: requestId,
        created: created,
        model: "gpt-3.5-turbo",
        object: "chat.completion",
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            message: {
              content: text,
              role: "assistant",
            },
          },
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      });

      return new Response(responseBody, { headers });
    }
  } catch (error: any) {
    console.error('Error handling chat completion:', error);
    return new Response(JSON.stringify({
      status: false,
      error: {
        message: "An error happened, please make sure your request is SFW, or use a jailbreak to bypass the filter.",
        type: "invalid_request_error",
      },
      support: "https://discord.pawan.krd",
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
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
