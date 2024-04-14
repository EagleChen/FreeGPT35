import { AutoRouter, cors } from 'itty-router'
import axios from "axios";
// import https from "https";
// import { randomUUID } from "crypto";

// Constants for the server and API configuration
const port = 3040;
const baseUrl = "https://chat.openai.com";
const apiUrl = `${baseUrl}/backend-api/conversation`;
const refreshInterval = 60000; // Interval to refresh token in ms
const errorWait = 120000; // Wait time in ms after an error

const authToken = 'YOUR_AUTH_HEADER';

// Initialize global variables to store the session token and device ID
let token;
let oaiDeviceId;

// Function to wait for a specified duration
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function GenerateCompletionId(prefix = "cmpl-") {
  const characters =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const length = 28;

  for (let i = 0; i < length; i++) {
    prefix += characters.charAt(Math.floor(Math.random() * characters.length));
  }

  return prefix;
}

async function* chunksToLines(chunksAsync) {
  let previous = "";
  for await (const chunk of chunksAsync) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    previous += bufferChunk;
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

async function* StreamCompletion(data) {
  yield* linesToMessages(chunksToLines(data));
}

// Setup axios instance for API requests with predefined configurations
const axiosInstance = axios.create({
  // httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  headers: {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "no-cache",
    "content-type": "application/json",
    "oai-language": "en-US",
    origin: baseUrl,
    pragma: "no-cache",
    referer: baseUrl,
    "sec-ch-ua":
      '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  },
});

// Function to get a new session ID and token from the OpenAI API
async function getNewSessionId() {
  let newDeviceId = crypto.randomUUID();
  const response = await axiosInstance.post(
    `${baseUrl}/backend-anon/sentinel/chat-requirements`,
    {},
    {
      headers: { "oai-device-id": newDeviceId },
    }
  );
  console.log(
    `System: Successfully refreshed session ID and token. ${
      !token ? "(Now it's ready to process requests)" : ""
    }`
  );
  oaiDeviceId = newDeviceId;
  token = response.data.token;
}

function checkAuthorizationHeader(req) {
  const authorizationHeader = req.headers.get('Authorization');

  if (!authorizationHeader) {
    return new Response(JSON.stringify({ error: 'Auth missing' }), {
      headers: {
        "Content-Type": "application/json"
      },
      status: 401
    });
  }

  // 检查授权标头格式
  const parts = authorizationHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return new Response(JSON.stringify({ error: 'Invalid auth format' }), {
      headers: {
        "Content-Type": "application/json"
      },
      status: 400
    });
  }

  if (parts[1] !== authToken) {
    return new Response(JSON.stringify({ error: 'Auth failed' }), {
      headers: {
        "Content-Type": "application/json"
      },
      status: 401
    });
  }

  return undefined;
}

// Middleware to handle chat completions
async function handleChatCompletion(request) {
  const res = checkAuthorizationHeader(request);
  if (res) {
    return res;
  }

  if ((!oaiDeviceId || !token) || (Math.random() < 0.3)) {
    await getNewSessionId();
  }

  const req = {
    body: await request.json(),
  };
  console.log(
    "Request:",
    `${req.body?.messages?.length || 0} messages`,
    req.body.stream ? "(stream-enabled)" : "(stream-disabled)"
  );
  try {
    const body = {
      action: "next",
      messages: req.body.messages.map((message) => ({
        author: { role: message.role },
        content: { content_type: "text", parts: [message.content] },
      })),
      parent_message_id: randomUUID(),
      model: "text-davinci-002-render-sha",
      timezone_offset_min: -180,
      suggestions: [],
      history_and_training_disabled: true,
      conversation_mode: { kind: "primary_assistant" },
      websocket_request_id: randomUUID(),
    };

    const response = await axiosInstance.post(apiUrl, body, {
      responseType: "stream",
      headers: {
        "oai-device-id": oaiDeviceId,
        "openai-sentinel-chat-requirements-token": token,
      },
    });

    // Set the response headers based on the request type
    if (req.body.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
    } else {
      res.setHeader("Content-Type", "application/json");
    }

    let fullContent = "";
    let requestId = GenerateCompletionId("chatcmpl-");
    let created = Date.now();

    for await (const message of StreamCompletion(response.data)) {
      // Skip heartbeat detection
			if (message.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}.\d{6}$/)) continue;

      const parsed = JSON.parse(message);

      let content = parsed?.message?.content?.parts[0] || "";

      for (let message of req.body.messages) {
        if (message.content === content) {
          content = "";
          break;
        }
      }

      if (content === "") continue;

      if (req.body.stream) {
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

        res.write(`data: ${JSON.stringify(response)}\n\n`);
      }

      fullContent = content.length > fullContent.length ? content : fullContent;
    }

    if (req.body.stream) {
      res.write(
        `data: ${JSON.stringify({
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
        })}\n\n`
      );
    } else {
      res.write(
        JSON.stringify({
          id: requestId,
          created: created,
          model: "gpt-3.5-turbo",
          object: "chat.completion",
          choices: [
            {
              finish_reason: "stop",
              index: 0,
              message: {
                content: fullContent,
                role: "assistant",
              },
            },
          ],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        })
      );
    }

    res.end();
  } catch (error) {
    // console.log('Error:', error.response?.data ?? error.message);
    if (!res.headersSent) res.setHeader("Content-Type", "application/json");
    // console.error('Error handling chat completion:', error);
    res.write(
      JSON.stringify({
        status: false,
        error: {
          message:
            "An error happened, please make sure your request is SFW, or use a jailbreak to bypass the filter.",
          type: "invalid_request_error",
        },
      })
    );
    res.end();
  }
}

const { preflight, corsify } = cors()
// Initialize router app and use middlewares
const router = AutoRouter({
  before: [preflight],  // add preflight upstream
  finally: [corsify],   // and corsify downstream
})

// Route to handle POST requests for chat completions
router.post("/v1/chat/completions", handleChatCompletion);

// 404 handler for unmatched routes
router.all("*", () => new Response({
  status: false,
  error: {
    message: `The requested endpoint was not found. please make sure to use "http://localhost:3040/v1" as the base URL.`,
    type: "invalid_request_error",
  },
}, { status: 404 }))

export default { ...router };