/**
 * ContextAI - WhatsApp Web UI Backend
 * Team Gear5
 *
 * Professional WhatsApp chat analyzer with QR authentication and AI summarization
 */

const { Client, LocalAuth } = require("whatsapp-web.js");
const express = require("express");
const cors = require("cors");
const qrcode = require("qrcode");
const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");
const { createModel, getStatus, HOSTS, TEXT_MODEL } = require("./llm");
const sharp = require("sharp");

const axios = require("axios");
const projectMapping = require("./project_mapping.json");
const INGEST_SERVER_URL = "http://localhost:3000/api/v1/ingest";

// Load environment variables
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" })); // Increased limit for dashboard AI with many summaries
app.use(express.urlencoded({ limit: "50mb", extended: true }));

let client = null;
let isReady = false;
let currentQR = null;
let allChats = [];
let chatFetchPromise = null;
let chatFetchStartedAt = null;
let lastChatFetchError = null;
let isLoggingOut = false;
let isReconnecting = false; // Track if this is a reconnect/re-login
let botStartTime = null; // Track when bot started to ignore old messages

// Bot state
let lastCheckedMessages = {}; // Track last message timestamp per group
const processedMessages = new Set(); // Track processed message IDs to prevent duplicates
let botResponseCooldowns = {}; // Track cooldowns per group to prevent spam
const BOT_COOLDOWN_MS = 5000; // 5 seconds cooldown between responses per group
let conversationMemory = {}; // Track conversation history per chat (last 20 messages per chat)

// Request queue for AI calls to prevent overload
let aiRequestQueue = [];
let isProcessingQueue = false;
const MAX_CONCURRENT_AI_REQUESTS = 2; // Process 2 requests at a time
let activeAIRequests = 0;

// Initialize the AI engine: Ollama (minimax-m3:cloud) with one model
// handle per host for round-robin load balancing + cross-host failover.
// Each handle is pinned to a host but still fails over to the others, so the
// existing retry/cycling logic keeps working - it now cycles hosts, not keys.
const geminiModels = HOSTS.map((host) => createModel({ host }));
let currentModelIndex = 0;

if (geminiModels.length === 0) {
  console.warn("⚠️ No OLLAMA_HOSTS configured - AI summarization disabled");
} else {
  HOSTS.forEach((host, index) => {
    console.log(`🤖 Ollama AI #${index + 1} -> ${host} (${TEXT_MODEL})`);
  });
  console.log(`✅ Total active Ollama hosts: ${geminiModels.length}`);
}

// Get next available model (round-robin load balancing across hosts)
function getGeminiModel() {
  if (geminiModels.length === 0) {
    return null;
  }

  // Round-robin through all available hosts
  currentModelIndex = (currentModelIndex + 1) % geminiModels.length;
  const model = geminiModels[currentModelIndex];
  console.log(
    `   🔄 Using Ollama host #${currentModelIndex + 1} of ${geminiModels.length}`
  );
  return model;
}

// AI engine status endpoint (Ollama hosts + models). Mounted at both
// /api/keys/status (legacy alias) and /api/ai/status so existing frontends
// keep working while the docs use the consistent name.
app.get("/api/ai/status", async (req, res) => {
  try {
    res.json(await getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/keys/status", async (req, res) => {
  try {
    res.json(await getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
function getTimeAgo(timestamp) {
  const now = Date.now() / 1000; // Current time in seconds
  const seconds = Math.floor(now - timestamp);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return `${Math.floor(seconds / 604800)}w ago`;
}

// Helper function to analyze images using Ollama vision (minimax-m3)
async function analyzeImage(message, context = "", personality = null) {
  try {
    if (!message.hasMedia) return null;

    const media = await message.downloadMedia();
    if (!media || !media.mimetype.startsWith("image/")) return null;

    console.log("🖼️ Image detected, analyzing with Ollama vision (minimax-m3)...");

    const model = getGeminiModel();
    if (!model) {
      console.log("   ⚠️ No AI model available for vision analysis");
      return null;
    }

    // Prepare image (base64 + mime); llm.js routes this to a vision-capable host
    const imagePart = {
      inlineData: {
        data: media.data,
        mimeType: media.mimetype,
      },
    };

    // Build prompt with personality if provided
    let prompt;
    if (personality && context) {
      prompt = `${personality.prompt}

User question: ${context}

Describe this image and answer their question. Use your personality but stay helpful.`;
    } else if (personality) {
      prompt = `${personality.prompt}

Describe this image in detail using your personality. What do you see?`;
    } else {
      prompt = context
        ? `${context}\n\nDescribe this image in detail and answer any questions about it.`
        : "Describe this image in detail. What do you see?";
    }

    const result = await retryWithBackoff(
      async () => {
        return await model.generateContent([prompt, imagePart]);
      },
      2,
      1500
    );

    const response = result.response;
    const description = response.text();

    console.log(`   ✅ Image analyzed: ${description.substring(0, 100)}...`);
    return description;
  } catch (err) {
    console.error("❌ Image analysis failed:", err.message);
    return null;
  }
}

// Queue-based AI request handler to prevent overload
async function queueAIRequest(requestFn, priority = 0) {
  return new Promise((resolve, reject) => {
    const request = {
      fn: requestFn,
      resolve,
      reject,
      priority,
      timestamp: Date.now(),
    };

    // Add to queue (higher priority first, then FIFO)
    aiRequestQueue.push(request);
    aiRequestQueue.sort(
      (a, b) => b.priority - a.priority || a.timestamp - b.timestamp
    );

    console.log(
      `   📊 Queue: ${aiRequestQueue.length} pending, ${activeAIRequests}/${MAX_CONCURRENT_AI_REQUESTS} active`
    );

    // Start processing if not already running
    if (!isProcessingQueue) {
      processAIQueue();
    }
  });
}

// Process queued AI requests with concurrency control
async function processAIQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (aiRequestQueue.length > 0 || activeAIRequests > 0) {
    // Wait if at max concurrency
    while (
      activeAIRequests >= MAX_CONCURRENT_AI_REQUESTS &&
      aiRequestQueue.length > 0
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Get next request from queue
    const request = aiRequestQueue.shift();
    if (!request) {
      // Wait for active requests to complete
      if (activeAIRequests > 0) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      break;
    }

    // Execute request (don't await, let it run concurrently)
    activeAIRequests++;
    request
      .fn()
      .then((result) => {
        request.resolve(result);
      })
      .catch((error) => {
        console.error(
          `   ❌ Queue request failed: ${error.message.substring(0, 100)}`
        );

        // Check if it's a retryable error and we haven't exceeded retry limit
        const isRetryable =
          error.message.includes("503") ||
          error.message.includes("overloaded") ||
          error.message.includes("RESOURCE_EXHAUSTED");

        if (isRetryable && (!request.retryCount || request.retryCount < 2)) {
          // Requeue with incremented retry count
          request.retryCount = (request.retryCount || 0) + 1;
          console.log(
            `   🔄 Requeueing request (retry ${request.retryCount}/2)...`
          );
          aiRequestQueue.push(request);
        } else {
          // Max retries reached or non-retryable error
          request.reject(error);
        }
      })
      .finally(() => {
        activeAIRequests--;
      });

    // Small delay between starting requests
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  isProcessingQueue = false;
}

// Retry helper for API calls with exponential backoff and multi-key cycling
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 2000) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Try with current model
      return await fn();
    } catch (error) {
      lastError = error;
      const isRetryable =
        error.message.includes("503") ||
        error.message.includes("500") ||
        error.message.includes("overloaded") ||
        error.message.includes("429") ||
        error.message.includes("Internal Server Error") ||
        error.message.includes("internal error") ||
        error.message.includes("RESOURCE_EXHAUSTED") ||
        // Transient Ollama connectivity (cold cloud proxy, brief restart)
        error.message.includes("fetch failed") ||
        error.message.includes("ECONNREFUSED") ||
        error.message.includes("ECONNRESET") ||
        error.message.includes("ETIMEDOUT") ||
        error.message.includes("socket hang up") ||
        error.message.includes("aborted");

      const isOverloaded =
        error.message.includes("overloaded") ||
        error.message.includes("RESOURCE_EXHAUSTED") ||
        error.message.includes("503");

      // If overloaded and we have multiple API keys, cycle through ALL of them
      if (isOverloaded && geminiModels.length > 1) {
        console.log(
          `   ⚠️ API overloaded, cycling through all ${geminiModels.length} keys...`
        );

        // Try each remaining API key (don't retry the one that just failed)
        const startIndex = currentModelIndex;
        for (
          let keyAttempt = 1;
          keyAttempt < geminiModels.length;
          keyAttempt++
        ) {
          try {
            // Move to next key
            currentModelIndex = (currentModelIndex + 1) % geminiModels.length;
            const alternateModel = geminiModels[currentModelIndex];
            console.log(
              `   🔄 Trying API #${currentModelIndex + 1} of ${
                geminiModels.length
              }`
            );
            return await fn(alternateModel);
          } catch (alternateError) {
            if (keyAttempt === geminiModels.length - 1) {
              console.log(
                `   ⚠️ All ${geminiModels.length} API keys tried, will wait and retry...`
              );
              lastError = alternateError;
            }
          }
        }
      }

      if (attempt === maxRetries || !isRetryable) {
        throw lastError;
      }

      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(
        `⚠️ API error (attempt ${attempt}/${maxRetries}), retrying in ${
          delay / 1000
        }s...`
      );
      console.log(`   Error: ${error.message.substring(0, 100)}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// Check if bot can respond (spam protection)
function canBotRespond(groupId) {
  const now = Date.now();

  // Check cooldown (5 seconds between responses)
  if (botResponseCooldowns[groupId]) {
    const timeSinceLastResponse = now - botResponseCooldowns[groupId];
    if (timeSinceLastResponse < BOT_COOLDOWN_MS) {
      const remainingSeconds = Math.ceil(
        (BOT_COOLDOWN_MS - timeSinceLastResponse) / 1000
      );
      console.log(
        `   ⏳ Cooldown active: ${remainingSeconds}s remaining - silently ignoring`
      );
      return { allowed: false, silent: true }; // Don't send spam warning
    }
  }

  return { allowed: true };
}

// Record bot response
function recordBotResponse(groupId) {
  const now = Date.now();
  botResponseCooldowns[groupId] = now;
  console.log(`   ✅ Response recorded (5s cooldown started)`);

  // Prune stale cooldown entries so this map can't grow without bound over a
  // long-running session (a cooldown is only meaningful for BOT_COOLDOWN_MS).
  for (const [id, ts] of Object.entries(botResponseCooldowns)) {
    if (now - ts > BOT_COOLDOWN_MS * 10) delete botResponseCooldowns[id];
  }
}

// Initialize WhatsApp client
function initializeClient() {
  if (client) {
    client.removeAllListeners();
  }

  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: ".wwebjs_auth",
    }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
      ],
      executablePath: undefined, // Use bundled Chromium
    },
  });

  // QR Code event
  client.on("qr", async (qr) => {
    console.log("📱 QR Code generated - Scan to login");
    try {
      currentQR = await qrcode.toDataURL(qr);
    } catch (err) {
      console.error("Error generating QR:", err);
    }
  });

  // Ready event
  client.on("ready", async () => {
    console.log("✅ WhatsApp is ready!");

    // Wait longer for client to fully initialize after re-login
    const waitTime = isReconnecting ? 30000 : 5000; // Increased from 15s to 30s for reconnection
    console.log(
      `⏳ Waiting ${waitTime / 1000}s for client to fully initialize${
        isReconnecting ? " (reconnecting - allowing chat sync time)" : ""
      }...`
    );
    await new Promise((resolve) => setTimeout(resolve, waitTime));

    isReady = true;
    currentQR = null;
    isLoggingOut = false;

    // Keep reconnecting flag for a bit longer to allow chat fetching to use extended timeout
    const wasReconnecting = isReconnecting;
    if (isReconnecting) {
      setTimeout(() => {
        isReconnecting = false;
        console.log("✅ Reconnection stabilization complete");
      }, 60000); // Keep flag for 60s to allow first few chat fetches to use extended timeout
    }

    botStartTime = Date.now(); // Mark when bot became ready

    console.log(
      "💡 WhatsApp ready - bot will only respond to NEW mentions after this point"
    );
    if (wasReconnecting) {
      console.log(
        "📊 Chat syncing in progress - first fetch may take longer..."
      );
    }

    // Pre-load conversation memory for bot-enabled groups
    if (botConfig.enabled && botConfig.groups.length > 0) {
      setTimeout(() => {
        preloadBotMemory().catch((err) => {
          console.error("❌ Error pre-loading bot memory:", err.message);
        });
      }, 2000); // Small delay to let everything settle
    }
  });

  // Message event for bot auto-responses
  client.on("message", async (message) => {
    try {
      const chatId = message.from;
      const text = message.body;

      // 1. Check if this chat is in our mapping file
      const mapping = projectMapping[chatId];

      // 2. If it is, and it has text, send it to the brain
      if (mapping && text) {
        console.log(
          `[INGEST] Chat ${chatId} IS mapped. Sending to RAG server...`
        );
        const payload = {
          project_id: mapping.project_id,
          team_id: mapping.team_id,
          source: "whatsapp",
          text: text,
        };

        axios
          .post(INGEST_SERVER_URL, payload)
          .then(() => {
            console.log(
              `[INGEST] SUCCESS: Sent message from ${chatId} to RAG server.`
            );
          })
          .catch((err) => {
            console.error(
              "[INGEST] FAILED to send to RAG server:",
              err.message
            );
          });
      } else if (text) {
        // This is the new "loud" part
        console.log(
          `[INGEST] Chat ${chatId} is NOT in project_mapping.json. Ignoring.`
        );
      }
    } catch (err) {
      console.error("[INGEST] Error processing message for ingestion:", err);
    }

    console.log(
      "📨 Message received:",
      message.from,
      message.body?.substring(0, 50)
    );

    try {
      // Ignore messages sent before bot started (only respond to NEW mentions)
      if (botStartTime && message.timestamp * 1000 < botStartTime) {
        console.log(`   ⏮️ Message is from before bot started - ignoring`);
        return;
      }

      // Check if we've already processed this message
      const messageId = message.id._serialized;
      if (processedMessages.has(messageId)) {
        console.log(`   ⏭️ Already processed this message, skipping`);
        return;
      }

      // Only process group messages
      const chat = await message.getChat();
      console.log(`   Chat type: ${chat.isGroup ? "GROUP" : "INDIVIDUAL"}`);
      if (!chat.isGroup) return;

      // Check if bot is enabled for this group
      const botConfig = await getBotConfig();
      console.log(
        `   Bot enabled: ${botConfig.enabled}, Groups: ${botConfig.groups.length}`
      );
      if (!botConfig.enabled) return;

      const enabledGroupIds = botConfig.groups.map((g) => g.id);
      console.log(
        `   Checking if ${chat.id._serialized} is in enabled groups...`
      );
      if (!enabledGroupIds.includes(chat.id._serialized)) {
        console.log(`   ❌ Group not in enabled list`);
        return;
      }

      // Check if message mentions us
      const mentionedIds = message.mentionedIds || [];
      const myId = client.info.wid._serialized;
      const myNumber = String(myId).split("@")[0]; // Extract just the number part

      console.log(`   My ID: ${myId} (number: ${myNumber})`);
      console.log(`   Mentioned IDs: ${mentionedIds.join(", ")}`);

      // Normalize mentioned IDs to compare just the number part (handles @lid, @c.us, etc.)
      const mentionedNumbers = mentionedIds.map(
        (id) => String(id).split("@")[0]
      );
      console.log(
        `   Mentioned Numbers (normalized): ${mentionedNumbers.join(", ")}`
      );

      // IMPORTANT: Check if ANY number was mentioned (not just our exact ID)
      // This allows the bot to respond when @mentioned by any contact name in the group
      const isMentioned =
        mentionedIds.length > 0 || mentionedNumbers.includes(myNumber);

      const isReplyToMe =
        message.hasQuotedMsg &&
        (await message.getQuotedMessage()).from === myId;

      console.log(
        `   Is mentioned: ${isMentioned}, Is reply to me: ${isReplyToMe}`
      );
      if (!isMentioned && !isReplyToMe) {
        console.log(`   ❌ Not mentioned or replied to`);
        return;
      }

      // Mark message as processed BEFORE we start processing
      processedMessages.add(messageId);
      console.log(`   ✓ Message marked as processed: ${messageId}`);

      const contact = await client.getContactById(message.from);
      console.log(
        `🤖 Bot triggered in ${chat.name} by ${
          contact.pushname || contact.name
        }`
      );

      // Check spam protection
      const canRespond = canBotRespond(chat.id._serialized);
      if (!canRespond.allowed) {
        console.log(`   🚫 Rate limited - silently ignoring`);
        return; // Silently ignore, don't send spam warning
      }

      // Use conversation memory for this chat
      const chatId = chat.id._serialized;
      if (!conversationMemory[chatId]) {
        conversationMemory[chatId] = [];
      }

      // Get personality for this group (use throughout message handling)
      const groupConfig = botConfig.groups.find(
        (g) => g.id === chat.id._serialized
      );
      const personalityKey = groupConfig?.personality || "hyderabadi";
      const personality = BOT_PERSONALITIES[personalityKey];

      console.log(`   🎭 Using personality: ${personality.name}`);

      // Get message text
      const messageText = message.body || "";

      // ========== CHECK FOR IMAGE TO ANALYZE ==========
      let imageAnalysis = null;
      if (message.hasMedia) {
        const userQuestion = messageText.trim();
        imageAnalysis = await analyzeImage(message, userQuestion, personality);
      }

      // If replied to a message with image, analyze that too
      if (isReplyToMe && message.hasQuotedMsg) {
        const quotedMsg = await message.getQuotedMessage();
        if (quotedMsg.hasMedia && !imageAnalysis) {
          imageAnalysis = await analyzeImage(
            quotedMsg,
            messageText,
            personality
          );
        }
      }

      // If we got image analysis, respond with it
      if (imageAnalysis) {
        console.log(`   🖼️ Sending image analysis response`);

        // Add to memory
        conversationMemory[chatId].push({
          sender: contact.pushname || contact.name || "User",
          text: `[Sent an image] ${messageText}`,
          timestamp: message.timestamp,
        });

        conversationMemory[chatId].push({
          sender: "Bot",
          text: imageAnalysis,
          timestamp: Date.now() / 1000,
        });

        // Keep only last 50 messages
        if (conversationMemory[chatId].length > 50) {
          conversationMemory[chatId] = conversationMemory[chatId].slice(-50);
        }

        recordBotResponse(chat.id._serialized);
        await message.reply(imageAnalysis);
        console.log(`✅ Bot sent image analysis in ${chat.name}`);
        return;
      }

      // Add current user message to memory FIRST (before generating response)
      conversationMemory[chatId].push({
        sender: contact.pushname || contact.name || "User",
        text: messageText,
        timestamp: message.timestamp,
      });

      // Keep only last 50 messages (25 exchanges) for better context
      if (conversationMemory[chatId].length > 50) {
        conversationMemory[chatId] = conversationMemory[chatId].slice(-50);
      }

      // Check if user is asking for a summary
      const summaryMatch = messageText.match(
        /summarize\s+(?:the\s+)?(?:last\s+)?(\d+)\s+messages?/i
      );

      if (summaryMatch) {
        const numMessages = parseInt(summaryMatch[1]);
        console.log(
          `   📊 User requested summary of last ${numMessages} messages`
        );

        // Fetch the requested number of messages
        const messages = await chat.fetchMessages({ limit: numMessages });
        const messagesToSummarize = messages
          .reverse()
          .map((msg) => {
            const sender = msg.author
              ? msg.author.split("@")[0]
              : msg.fromMe
              ? "Bot"
              : "User";
            return `${sender}: ${msg.body}`;
          })
          .join("\n");

        const summaryPrompt = `Summarize the following WhatsApp group conversation. Highlight the main topics discussed, key points, and any decisions or action items. Be concise but comprehensive:

${messagesToSummarize}

Provide a clear summary in 3-5 bullet points.`;

        console.log(`   🤖 Generating summary...`);
        const model = getGeminiModel();
        if (!model) {
          await message.reply(
            "⚠️ AI engine unavailable. Check OLLAMA_HOSTS and that the Ollama server is running."
          );
          return;
        }

        const result = await queueAIRequest(async () => {
          const model = getGeminiModel();
          return await retryWithBackoff(async (altModel) => {
            const useModel = altModel || model;
            return await useModel.generateContent(summaryPrompt);
          });
        }, 10); // High priority for bot responses

        const summary = result.response.text();
        console.log(`   📤 Sending summary`);

        // Add bot's summary to memory (marked as summary to exclude from conversation context)
        conversationMemory[chatId].push({
          sender: "Bot",
          text: `Summary: ${summary}`,
          timestamp: Date.now() / 1000,
          isSummary: true, // Exclude from conversation context
        });

        recordBotResponse(chat.id._serialized);
        await message.reply(
          `📋 *Summary of last ${numMessages} messages:*\n\n${summary}`
        );
        console.log(`✅ Bot sent summary in ${chat.name}`);
        return;
      }

      // Get stored conversation history for context WITH TIMESTAMPS
      // Filter OUT bot summaries to keep context clean and focused
      const recentContext = conversationMemory[chatId]
        .filter((msg) => !msg.isSummary) // Exclude summary messages from context
        .slice(-30) // Use last 30 actual conversation messages
        .map((msg) => {
          const timeAgo = getTimeAgo(msg.timestamp);
          return `[${timeAgo}] ${msg.sender}: ${msg.text}`;
        })
        .join("\n");

      const contextCount = conversationMemory[chatId].filter(
        (msg) => !msg.isSummary
      ).length;
      console.log(
        `   💭 Using ${contextCount} conversation messages (excluding summaries, showing last 30)`
      );

      // --- NEW RAG-POWERED BOT LOGIC WITH PERSONALITY-INFUSED RESPONSES ---

      // 1. Find the project/team mapping
      const mapping = projectMapping[chat.id._serialized];

      let ragData = null;
      let answer = null;

      // 2. Try RAG first if chat is mapped to get factual data
      if (mapping) {
        // Build the payload for our backend-server
        const ragPayload = {
          project_id: mapping.project_id,
          team_id: mapping.team_id,
          question: messageText, // The user's message
        };

        // 3. Call the RAG server's "ask" endpoint
        console.log(
          `[RAG-BOT] Sending question to RAG server: "${messageText}"`
        );
        try {
          const ragResponse = await axios.post(
            "http://localhost:3000/api/v1/ask",
            ragPayload
          );
          const ragAnswer = ragResponse.data.answer;

          console.log(
            `[RAG-BOT] Received answer: ${ragAnswer.substring(0, 100)}...`
          );

          // Check if RAG found relevant information (not a generic "I don't know" response)
          const answerLower = ragAnswer.toLowerCase();
          const isGenericNoAnswer =
            answerLower.includes("don't have") ||
            answerLower.includes("do not have") ||
            answerLower.includes("don't know") ||
            answerLower.includes("do not know") ||
            answerLower.includes("no information") ||
            answerLower.includes("can't find") ||
            answerLower.includes("cannot find") ||
            answerLower.includes("couldn't find") ||
            answerLower.includes("could not find") ||
            answerLower.includes("not found") ||
            answerLower.includes("no context") ||
            answerLower.includes("no relevant") ||
            answerLower.includes("unable to find") ||
            answerLower.includes("no specific information") ||
            answerLower.includes("i don't have access") ||
            answerLower.includes("not available in") ||
            (answerLower.length < 50 && answerLower.includes("sorry"));

          if (!isGenericNoAnswer) {
            ragData = ragAnswer;
            console.log(
              `[RAG-BOT] Found relevant data, will combine with personality`
            );
          } else {
            console.log(
              `[RAG-BOT] RAG returned generic no-answer, using pure chatbot`
            );
          }
        } catch (err) {
          console.error("❌ RAG-BOT Error:", err.message);
          console.log(`[RAG-BOT] Error querying RAG, using pure chatbot`);
        }
      } else {
        console.log(
          `[RAG-BOT] Chat ${chat.id._serialized} is not in project_mapping.json. Using pure chatbot mode.`
        );
      }

      // 4. Generate response with personality (with or without RAG data)
      console.log(
        `[CHATBOT] Generating response with personality: ${personality.name}`
      );

      let prompt;
      if (ragData) {
        // Combine RAG data with personality
        prompt = `${personality.prompt}

Recent conversation history (your memory):
${recentContext}

IMPORTANT DATABASE INFORMATION about the question:
${ragData}

Current question from ${contact.pushname || contact.name || "User"}:
${messageText}

Respond to the question using the DATABASE INFORMATION above, but deliver it in your natural ${
          personality.name
        } style and personality. Make the technical information friendly and conversational while keeping it accurate. Include the factual details from the database but present them in your unique way.`;
      } else {
        // Pure chatbot response without RAG data
        prompt = `${personality.prompt}

Recent conversation history (your memory):
${recentContext}

Current question from ${contact.pushname || contact.name || "User"}:
${messageText}

Respond naturally and helpfully as ${
          personality.name
        }. If they ask about previous messages or "last chat", refer to the conversation history above. Keep your response concise but friendly.`;
      }

      console.log(
        `   🤖 Generating ${
          ragData ? "RAG-infused" : "pure"
        } chatbot response...`
      );
      const model = getGeminiModel();
      if (!model) {
        await message.reply("⚠️ AI engine unavailable. Check OLLAMA_HOSTS and that the Ollama server is running.");
        return;
      }

      const result = await queueAIRequest(async () => {
        const model = getGeminiModel();
        return await retryWithBackoff(async (altModel) => {
          const useModel = altModel || model;
          return await useModel.generateContent(prompt);
        });
      }, 10); // High priority for bot responses

      answer = result.response.text();
      console.log(
        `[CHATBOT] Generated response: ${answer.substring(0, 100)}...`
      );

      // 5. Send the response (personality-infused, with or without RAG data)
      // Add to conversationMemory
      conversationMemory[chatId].push({
        sender: "Bot",
        text: answer,
        timestamp: Date.now() / 1000,
      });

      // Keep only last 50 messages
      if (conversationMemory[chatId].length > 50) {
        conversationMemory[chatId] = conversationMemory[chatId].slice(-50);
      }

      // Record the response for spam protection
      recordBotResponse(chat.id._serialized);

      // Reply to the message
      await message.reply(answer);
      console.log(
        `✅ Bot responded in ${chat.name} (mode: ${
          ragData ? "Personality + RAG Data" : "Pure Personality"
        })`
      );
    } catch (err) {
      console.error("❌ Message handling error:", err.message);
      try {
        await message.reply(
          "I'm sorry, I encountered an error. Please try again."
        );
      } catch (e) {
        console.error("Failed to send error message:", e);
      }
    }
  });

  // Authenticated
  client.on("authenticated", () => {
    console.log("✅ Authenticated successfully");
  });

  // Loading screen
  client.on("loading_screen", (percent, message) => {
    console.log(`⏳ Loading: ${percent}% - ${message}`);
  });

  // Auth failure
  client.on("auth_failure", (msg) => {
    console.log("❌ Authentication failed:", msg);
    isReady = false;
    currentQR = null;
  });

  // Disconnected
  client.on("disconnected", (reason) => {
    console.log("❌ Disconnected:", reason);
    isReady = false;
    allChats = [];

    if (!isLoggingOut) {
      console.log("🔄 Attempting to reconnect...");
      isReconnecting = true; // Mark as reconnecting
      setTimeout(() => {
        cleanupAuthFolder().then(() => {
          initializeClient();
          client.initialize();
        });
      }, 3000);
    }
  });

  return client;
}

// Cleanup auth folder safely and FAST.
//
// The session folder is a full Chromium user-data dir; deleting it directly is
// slow on Windows (locked files) and used to block a fresh QR for tens of
// seconds. Instead we rename it out of the way (near-instant) so a new client
// can start immediately, then delete the old copy in the background.
async function cleanupAuthFolder() {
  const authPath = path.join(__dirname, ".wwebjs_auth");
  try {
    const exists = await fsPromises
      .access(authPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) return;

    const tmpPath = `${authPath}.old-${Date.now()}`;
    try {
      await fsPromises.rename(authPath, tmpPath);
      // Delete the old profile in the background - don't block the new QR.
      fsPromises
        .rm(tmpPath, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 400,
        })
        .then(() => console.log("🧹 Old session files removed"))
        .catch((e) =>
          console.log("⚠️ Background session cleanup warning:", e.message)
        );
    } catch (renameErr) {
      // Rename can fail if handles are still open; fall back to a direct delete.
      await fsPromises.rm(authPath, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 400,
      });
      console.log("🧹 Cleaned up session files");
    }
  } catch (err) {
    console.log("⚠️ Session cleanup warning:", err.message);
    // Non-critical, continue anyway
  }
}

// API Endpoints
// (AI engine status is served by /api/ai/status and the /api/keys/status
//  alias defined near the top of this file.)

// AI hosts are configured via the OLLAMA_HOSTS env var, not at runtime.
app.post("/api/keys/add", (req, res) => {
  res.status(400).json({
    error:
      "ContextAI now uses Ollama. Configure servers via the OLLAMA_HOSTS environment variable (comma-separated, e.g. http://localhost:11434) and restart.",
  });
});

// Get status
app.get("/api/status", (req, res) => {
  const status = {
    connected: isReady,
    hasQR: currentQR !== null,
    chatCount: allChats.length,
    chatLoading: Boolean(chatFetchPromise),
    chatError: lastChatFetchError,
  };
  console.log("📊 Status check:", status);
  res.json(status);
});

// Get QR code
app.get("/api/qr", (req, res) => {
  if (currentQR) {
    res.json({ qr: currentQR });
  } else if (isReady) {
    res.json({ message: "Already connected" });
  } else {
    res.json({ message: "Initializing..." });
  }
});

async function refreshChatsCache() {
  if (!isReady) {
    throw new Error("WhatsApp not connected");
  }
  if (chatFetchPromise) {
    return chatFetchPromise;
  }

  chatFetchStartedAt = Date.now();
  lastChatFetchError = null;
  chatFetchPromise = (async () => {
    console.log(`📋 Fetching all chats...`);
    const startTime = Date.now();

    // Retry logic to handle "Evaluation failed" errors
    let chats = [];
    let retries = 3;

    while (retries > 0) {
      try {
        // WhatsApp Web can take a while to finish post-login sync.
        const fetchTimeout = isReconnecting ? 120000 : 90000;

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Timeout fetching chats")),
            fetchTimeout
          )
        );

        chats = await Promise.race([client.getChats(), timeoutPromise]);

        break; // Success, exit retry loop
      } catch (err) {
        retries--;

        if (
          (err.message.includes("Evaluation failed") ||
            err.message.includes("Timeout fetching chats")) &&
          retries > 0
        ) {
          console.log(
            `   ⚠️ WhatsApp not ready, retrying... (${retries} attempts left)`
          );
          await new Promise((resolve) => setTimeout(resolve, 5000));
          continue;
        }

        throw err; // Re-throw if not retryable or out of retries
      }
    }

    console.log(
      `✅ Retrieved ${chats.length} chats in ${Date.now() - startTime}ms`
    );

    // Map to minimal data WITHOUT fetching contact details
    allChats = chats.map((chat) => {
      let displayName = chat.name || chat.id.user || "Unknown Contact";

      return {
        id: chat.id._serialized,
        name: displayName,
        isGroup: chat.isGroup,
        unreadCount: chat.unreadCount || 0,
        timestamp: chat.timestamp || Date.now(),
      };
    });

    // Sort by most recent
    allChats.sort((a, b) => b.timestamp - a.timestamp);

    const totalTime = Date.now() - startTime;
    console.log(`✅ Processed ${allChats.length} chats in ${totalTime}ms`);

    return allChats;
  })();

  try {
    return await chatFetchPromise;
  } catch (err) {
    lastChatFetchError = err.message;
    throw err;
  } finally {
    chatFetchPromise = null;
    chatFetchStartedAt = null;
  }
}

// Get all chats. Chat loading is single-flight so repeated UI polling cannot
// pile up multiple WhatsApp Web evaluations and make the session time out.
app.get("/api/chats", async (req, res) => {
  if (!isReady) {
    return res.status(503).json({ error: "WhatsApp not connected" });
  }

  if (allChats.length > 0) {
    console.log(`📋 Returning ${allChats.length} cached chats`);
    return res.json({
      chats: allChats,
      count: allChats.length,
      loading: Boolean(chatFetchPromise),
    });
  }

  if (chatFetchPromise) {
    return res.status(202).json({
      chats: allChats,
      count: allChats.length,
      loading: true,
      startedAt: chatFetchStartedAt,
      message: "WhatsApp is still syncing chats. Please wait a moment.",
    });
  }

  refreshChatsCache().catch((err) => {
    console.error("❌ Error fetching chats:", err.message);
  });

  res.status(202).json({
    chats: [],
    count: 0,
    loading: true,
    startedAt: chatFetchStartedAt,
    message: "Started loading WhatsApp chats.",
  });
});

app.post("/api/chats/refresh", async (req, res) => {
  if (!isReady) {
    return res.status(503).json({ error: "WhatsApp not connected" });
  }

  if (chatFetchPromise) {
    return res.status(202).json({
      chats: allChats,
      count: allChats.length,
      loading: true,
      message: "Chat refresh already running.",
    });
  }

  allChats = [];
  refreshChatsCache().catch((err) => {
    console.error("❌ Error refreshing chats:", err.message);
  });

  res.status(202).json({
    chats: [],
    count: 0,
    loading: true,
    message: "Started refreshing WhatsApp chats.",
  });
});

// Get chat messages and summary
app.post("/api/messages", async (req, res) => {
  if (!isReady) {
    return res.status(503).json({ error: "WhatsApp not connected" });
  }

  const { chatId, limit = 100, analysisDepth = "moderate" } = req.body;

  if (!chatId) {
    return res.status(400).json({ error: "chatId required" });
  }

  try {
    console.log(`📥 Fetching messages for chat: ${chatId}`);
    console.log(`📊 Limit: ${limit} messages, Depth: ${analysisDepth}`);

    const chat = await client.getChatById(chatId);
    console.log(`✅ Chat found: ${chat.name || chat.id.user}`);

    console.log(`🔄 Fetching ${limit} messages...`);
    const messages = await chat.fetchMessages({ limit: parseInt(limit) });
    console.log(`✅ Retrieved ${messages.length} messages`);

    // Get participant info with names
    const participantMap = {};

    // For groups, get contact names
    if (chat.isGroup) {
      console.log(`👥 Fetching participant info for group...`);
      for (const participant of chat.participants) {
        try {
          const contact = await client.getContactById(
            participant.id._serialized
          );
          // Try to get the best name available
          const name =
            contact.name || contact.pushname || contact.verifiedName || null;
          if (name) {
            participantMap[participant.id.user] = name;
          } else {
            // Format phone number: +1234567890 instead of 1234567890
            participantMap[participant.id.user] = "+" + participant.id.user;
          }
        } catch (err) {
          // Format phone number: +1234567890 instead of 1234567890
          participantMap[participant.id.user] = "+" + participant.id.user;
        }
      }
      console.log(
        `✅ Loaded ${Object.keys(participantMap).length} participant names`
      );
    }

    const textMessages = messages
      .filter((m) => m.body && m.body.trim())
      .map((m) => {
        const authorNumber = m.author
          ? m.author.split("@")[0]
          : m.from
          ? m.from.split("@")[0]
          : "Unknown";
        // Use participant map if available, otherwise format phone number
        let authorName = participantMap[authorNumber];
        if (!authorName) {
          // For individual chats or unmapped participants, try to get contact name
          authorName = chat.name || "+" + authorNumber;
        }

        // Replace @mentions in message body with actual names
        let cleanedBody = m.body;
        // Match @12345678901234567 pattern (WhatsApp user ID mentions)
        const mentionPattern = /@(\d{10,15})/g;
        cleanedBody = cleanedBody.replace(mentionPattern, (match, userId) => {
          const mentionedName = participantMap[userId];
          return mentionedName ? `@${mentionedName}` : match;
        });

        return {
          id: m.id._serialized,
          body: cleanedBody, // Use cleaned body with resolved @mentions
          timestamp: m.timestamp,
          from: m.from,
          fromMe: m.fromMe,
          author: m.author || m.from,
          authorName: authorName,
          authorNumber: authorNumber,
        };
      });

    console.log(`📝 Processed ${textMessages.length} text messages`);

    // Check if we have no text messages (only media/deleted/system messages)
    if (textMessages.length === 0 && messages.length > 0) {
      console.log(
        `   ⚠️ No text messages found (${messages.length} total messages - likely media/deleted/system messages)`
      );
    }

    // Generate participant statistics with names
    const participants = {};
    textMessages.forEach((msg) => {
      const name = msg.authorName;
      participants[name] = (participants[name] || 0) + 1;
    });

    const timestamps = textMessages.map((m) => m.timestamp);
    const dateRange =
      timestamps.length > 0
        ? {
            oldest: new Date(
              Math.min(...timestamps) * 1000
            ).toLocaleDateString(),
            newest: new Date(
              Math.max(...timestamps) * 1000
            ).toLocaleDateString(),
          }
        : null;

    // Generate AI summary if available
    let aiSummary = null;
    if (getGeminiModel() && textMessages.length > 0) {
      try {
        console.log(`🤖 Queuing AI summary request (${analysisDepth} mode)...`);
        // Use queue with normal priority (0)
        aiSummary = await queueAIRequest(async () => {
          console.log("🤖 Generating AI summary...");
          return await generateAISummary(
            textMessages,
            chat.name || chat.id.user,
            chat.isGroup,
            analysisDepth
          );
        }, 0);
        console.log("✅ AI summary generated");
      } catch (err) {
        console.error("⚠️ AI summary failed:", err.message);
        aiSummary = null;
      }
    } else if (textMessages.length === 0 && messages.length > 0) {
      // Provide helpful message when there are no text messages
      aiSummary = `**ℹ️ No Text Messages Found**

This chat contains ${messages.length} message(s), but none of them have text content. This typically means:

* **📷 Media Only**: Messages contain only images, videos, or voice notes
* **🗑️ Deleted Messages**: Messages were deleted after being sent
* **📋 System Messages**: Group notifications (member added/removed, etc.)
* **🎨 Stickers/GIFs**: Non-text content only

**💡 Tip**: Try selecting a different chat with text messages for AI analysis.`;
      console.log("   ℹ️ Generated helpful message for media-only chat");
    } else if (textMessages.length === 0 && messages.length === 0) {
      // Empty chat
      aiSummary = `**ℹ️ Empty Chat**

This chat has no messages in the selected range (${limit} messages).

**💡 Tip**: This might be a new chat or all messages might be outside the analyzed range.`;
      console.log("   ℹ️ Generated message for empty chat");
    }

    const summary = {
      chatName: chat.name || chat.id.user,
      chatId: chat.id._serialized,
      isGroup: chat.isGroup,
      totalMessages: limit,
      textMessages: textMessages.length,
      dateRange,
      participants,
      participantMap,
      messages: textMessages,
      aiSummary,
      source: "whatsapp", // Add source identifier
    };

    console.log(
      `✅ Summary generated - ${textMessages.length} messages, ${
        Object.keys(participants).length
      } participants`
    );

    res.json(summary);
  } catch (err) {
    console.error("❌ Error fetching messages:", err.message);
    res.status(500).json({
      error: "Failed to fetch messages",
      message: err.message,
    });
  }
});

// Generate AI summary using Ollama with batching for large message sets
async function generateAISummary(
  messages,
  chatName,
  isGroup,
  analysisDepth = "moderate"
) {
  const model = getGeminiModel();
  if (!model || messages.length === 0) {
    return null;
  }

  const participantCount = new Set(messages.map((m) => m.authorName)).size;
  const chatType = isGroup ? "group chat" : "individual chat";
  const isDeepAnalysis = analysisDepth === "deep";

  console.log(
    `🔬 Analysis mode: ${analysisDepth.toUpperCase()}${
      isDeepAnalysis ? " (with research)" : ""
    }`
  );

  // For large message sets (>500), batch process to avoid overload
  const BATCH_SIZE = 500;
  let summaryText = "";

  if (messages.length > BATCH_SIZE) {
    console.log(
      `🔄 Large message set detected (${messages.length} messages) - using batch processing...`
    );

    // Process in batches and combine summaries
    const batches = [];
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      batches.push(messages.slice(i, i + BATCH_SIZE));
    }

    console.log(
      `📦 Processing ${batches.length} batches of ~${BATCH_SIZE} messages each...`
    );

    const batchSummaries = [];
    for (let i = 0; i < batches.length; i++) {
      console.log(`🤖 Processing batch ${i + 1}/${batches.length}...`);

      const batchContext = batches[i]
        .map((m) => `${m.authorName}: ${m.body}`)
        .join("\n");

      const batchPrompt = `Analyze this batch (${i + 1}/${
        batches.length
      }) of WhatsApp messages from "${chatName}":

${batchContext}

Provide a brief summary covering:
- Main topics discussed
- Key points and decisions
- Important quotes or information

Be concise but capture the essence of this conversation segment.`;

      try {
        const model = getGeminiModel();
        const result = await retryWithBackoff(
          async (altModel) => {
            const useModel = altModel || model;
            return await useModel.generateContent(batchPrompt);
          },
          3,
          2000
        );

        const response = await result.response;
        batchSummaries.push({
          batch: i + 1,
          summary: response.text(),
        });
        console.log(`✅ Batch ${i + 1}/${batches.length} processed`);

        // Small delay between batches to avoid rate limiting
        if (i < batches.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (err) {
        console.error(`❌ Error processing batch ${i + 1}:`, err.message);
        batchSummaries.push({
          batch: i + 1,
          summary: `[Error processing this batch: ${err.message}]`,
        });
      }
    }

    // Now synthesize all batch summaries into a final comprehensive summary
    console.log("🔄 Synthesizing batch summaries into final analysis...");

    const consolidatedContext = batchSummaries
      .map((b) => `Batch ${b.batch}:\n${b.summary}`)
      .join("\n\n---\n\n");

    const participantsNote =
      participantCount > 20
        ? ` Note: Large group with ${participantCount} participants - focus on message content, not individual contributors.`
        : ` with ${participantCount} participants`;

    const contributorSection =
      participantCount <= 20
        ? `

**👥 Key Contributors & Roles**
* Notable participants and main contributions (each on new line)`
        : "";

    const finalPrompt = `You have analyzed ${messages.length} WhatsApp messages from "${chatName}" (${chatType})${participantsNote} in ${batches.length} batches.

Here are the batch summaries:

${consolidatedContext}

Create a CONCISE summary using ONLY SHORT bullet points. Put EACH point on a NEW LINE:

**📊 Conversation Overview**
* High-level summary (one line)

**📋 Main Topics & Themes**
* Key topic (each on new line, 5-7 max)

**✅ Decisions & Agreements**
* Important decision (each on new line)

**📌 Action Items & Next Steps**
* Specific task: owner (each on new line)${contributorSection}

**💭 Sentiment & Tone Analysis**
* Overall tone (one line)

**⚡ Critical Highlights**
* Important moment (each on new line, 2-3 max)

**🔍 Patterns & Insights**
* Recurring theme (each on new line)

IMPORTANT: Each bullet (*) MUST start on its own line.`;

    try {
      const model = getGeminiModel();
      const result = await retryWithBackoff(
        async (altModel) => {
          const useModel = altModel || model;
          return await useModel.generateContent(finalPrompt);
        },
        3,
        2000
      );

      const response = await result.response;
      summaryText = response.text();
      console.log("✅ Final consolidated summary generated");
    } catch (err) {
      console.error("❌ Error generating final summary:", err.message);
      summaryText =
        `## Batch Summaries (${messages.length} messages)\n\n` +
        batchSummaries
          .map((b) => `### Batch ${b.batch}\n${b.summary}`)
          .join("\n\n");
    }
  } else {
    // Standard processing for smaller message sets
    const messageContext = messages
      .map((m) => `${m.authorName}: ${m.body}`)
      .join("\n");

    // Check if we should include contributor info (skip for large groups)
    const includeContributors = participantCount <= 20;

    const contributorSection = includeContributors
      ? `

**👥 Top 3 Contributors**
- Name: count`
      : "";

    // Different prompts based on analysis depth
    let prompt;

    if (isDeepAnalysis) {
      // Deep analysis with research mode
      prompt = `You are performing a DEEP ANALYSIS of "${chatName}" - ${
        messages.length
      } messages${
        participantCount > 20 ? ` (${participantCount} participants)` : ""
      }.

DEEP ANALYSIS INSTRUCTIONS:
1. Read ALL messages carefully to understand the full context
2. Identify technical terms, acronyms, references, or topics that may need clarification
3. Provide deeper insights into conversations, motivations, and implications
4. Connect related topics and identify cause-effect relationships
5. Research context: If terms/topics appear that need explanation (products, events, concepts), provide brief context
6. Analyze communication patterns and group dynamics

Messages:
${messageContext}

Create a COMPREHENSIVE analysis with SHORT bullet points (each on NEW LINE):

**📊 Deep Context Analysis**
* Overall purpose of this conversation
* Background context and setting
* Key relationships between participants (if visible)

**📋 Topics & Themes** (detailed)
* Main topic with context and why it matters
* Related subtopics and their connections
* Technical terms explained (if any)

**✅ Decisions & Reasoning**
* Decision made
* Reasoning behind it (if mentioned)
* Impact or implications

**📌 Action Items & Dependencies**
* Task: Owner (with deadline if mentioned)
* Prerequisites or dependencies
* Follow-up needed

${contributorSection}

**💭 Sentiment & Dynamics**
* Overall emotional tone
* Shifts in mood or energy
* Group dynamics observed

**⚡ Critical Insights** (3-5)
* Important moment with deeper meaning
* Why this matters in context
* Potential implications

**🔍 Patterns & Predictions**
* Recurring themes or behaviors
* Potential future directions
* Risks or opportunities identified

**🎯 Key Takeaways**
* Most important insight (each on new line, 2-3 max)

IMPORTANT: 
- Each bullet (*) MUST start on its own line
- Provide CONTEXT and EXPLANATION, not just listing
- If you see technical terms or references, briefly explain them
- Connect ideas and show relationships`;
    } else {
      // Moderate (standard) analysis
      prompt = `Analyze "${chatName}" - ${messages.length} messages${
        participantCount > 20 ? ` (${participantCount} participants)` : ""
      }. Create SHORT bullet summary:

**📊 Overview**
* Single line summary
* Timeframe

**📋 Topics** (3-5 max)
* Topic (each on new line)

**✅ Decisions**
* Decision (if any, each on new line)

**📌 Actions**  
* Task: Owner (if any, each on new line)${contributorSection}

**💭 Tone**
* One line

**⚡ Highlights** (2-3 max)
* Key moment (each on new line)

Messages:
${messageContext}

IMPORTANT: Put each bullet point on a NEW LINE. Do NOT continue points on same line after asterisk (*).`;
    }

    try {
      console.log(
        `🤖 Sending ${messages.length} messages to Ollama AI (${
          isDeepAnalysis ? "DEEP" : "MODERATE"
        } mode)...`
      );
      const model = getGeminiModel();
      const result = await retryWithBackoff(
        async (altModel) => {
          const useModel = altModel || model;
          return await useModel.generateContent(prompt);
        },
        3,
        2000
      );

      const response = await result.response;
      summaryText = response.text();
      console.log(
        `✅ Ollama AI summary generated successfully (${
          isDeepAnalysis ? "DEEP" : "MODERATE"
        } mode)`
      );
    } catch (err) {
      console.error("❌ Ollama AI error:", err.message);
      return null;
    }
  }

  return summaryText;
}

// Q&A endpoint - NOW POWERED BY OUR RAG SERVER
app.post("/api/chat-qa", async (req, res) => {
  if (!isReady) {
    return res.status(503).json({ error: "WhatsApp not connected" });
  }

  const { chatId, question, messageLimit = 200 } = req.body;

  if (!chatId || !question) {
    return res.status(400).json({ error: "chatId and question required" });
  }

  console.log(`[RAG] New Q&A Request for chat: ${chatId}`);
  console.log(`[RAG] Question: ${question}`);

  // 1. Find the project/team mapping
  const mapping = projectMapping[chatId];
  if (!mapping) {
    console.error(`[RAG] No project mapping found for chat: ${chatId}`);
    return res
      .status(404)
      .json({ error: "This chat is not mapped to a project." });
  }

  // 2. Build the payload for our backend-server
  const ragPayload = {
    project_id: mapping.project_id,
    team_id: mapping.team_id,
    question: question,
  };

  // 3. Call the RAG server's "ask" endpoint
  try {
    // We point to our other server: http://localhost:3000
    const ragResponse = await axios.post(
      "http://localhost:3000/api/v1/ask",
      ragPayload
    );

    // 4. Send the RAG server's answer directly to the frontend
    console.log("[RAG] Answer generated:", ragResponse.data.answer);
    res.json({
      question: question,
      answer: ragResponse.data.answer,
      chatName: mapping.project_id, // Use project_id as a placeholder
      contextMessages: 0, // We don't know this, so we send 0
    });
  } catch (err) {
    console.error("❌ RAG Q&A Error:", err.message);
    res.status(500).json({
      error: "Failed to answer question",
      message: err.message,
    });
  }
});

// Dashboard AI Q&A - Analyze across all cached summaries
app.post("/api/dashboard-qa", async (req, res) => {
  const model = getGeminiModel();
  if (!model) {
    return res.status(503).json({ error: "AI engine not configured (check OLLAMA_HOSTS)" });
  }

  const { summaries, question } = req.body;

  if (!summaries || !question) {
    return res.status(400).json({ error: "summaries and question required" });
  }

  try {
    console.log(`🤔 Dashboard Q&A Request`);
    console.log(`❓ Question: ${question}`);
    console.log(
      `📊 Analyzing ${Object.keys(summaries).length} chat summaries...`
    );

    // Build comprehensive context from all summaries
    const summaryContext = Object.entries(summaries)
      .map(([chatId, summary]) => {
        const chatInfo = [
          `Chat: ${summary.chatName || chatId}`,
          `Type: ${summary.isGroup ? "Group" : "Individual"}`,
          `Messages: ${summary.textMessages || 0}`,
          `Participants: ${Object.keys(summary.participants || {}).length}`,
          `Date Range: ${summary.dateRange?.oldest || "N/A"} to ${
            summary.dateRange?.newest || "N/A"
          }`,
          `\nAI Summary:\n${summary.aiSummary || "No summary available"}`,
        ];

        if (
          summary.participants &&
          Object.keys(summary.participants).length > 0
        ) {
          const topParticipants = Object.entries(summary.participants)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([name, count]) => `  - ${name}: ${count} messages`)
            .join("\n");
          chatInfo.push(`\nTop Contributors:\n${topParticipants}`);
        }

        return chatInfo.join("\n");
      })
      .join("\n\n" + "=".repeat(80) + "\n\n");

    const dashboardPrompt = `You are analyzing multiple WhatsApp chat summaries to answer user questions.

CHAT SUMMARIES (${Object.keys(summaries).length} chats):
${summaryContext}

USER QUESTION: ${question}

INSTRUCTIONS:
- Analyze ALL provided chat summaries to answer the question
- For correlation/pattern questions, compare across multiple chats
- For statistical questions, aggregate data from all chats
- Cite specific chats when making claims (e.g., "In the 'Team Meeting' chat...")
- Be precise and data-driven
- If the question can't be answered from the summaries, say so clearly
- Keep your answer under 300 words but be thorough

ANSWER:`;

    console.log("🤖 Sending dashboard Q&A to Ollama AI...");
    const result = await queueAIRequest(async () => {
      const model = getGeminiModel();
      return await retryWithBackoff(
        async (altModel) => {
          const useModel = altModel || model;
          return await useModel.generateContent(dashboardPrompt);
        },
        3,
        2000
      );
    }, 5); // Medium-high priority for dashboard Q&A

    const response = await result.response;
    const answer = response.text();

    console.log("✅ Dashboard answer generated");

    res.json({
      question,
      answer,
      analyzedChats: Object.keys(summaries).length,
    });
  } catch (err) {
    console.error("❌ Dashboard Q&A Error:", err.message);
    res.status(500).json({
      error: "Failed to answer question",
      message: err.message,
    });
  }
});

// Logout endpoint
app.post("/api/logout", async (req, res) => {
  if (!client) {
    return res.json({ success: true, message: "Already logged out" });
  }

  // Respond immediately - the teardown + fresh-client init runs in the
  // background and the new QR appears via the normal /api/status polling.
  // This is what makes logout feel instant instead of "forever".
  res.json({ success: true, message: "Logging out..." });

  // Detach the old client immediately. Nulling the shared `client` ref first
  // means any stray "message"/"disconnected" events from the dying session
  // can't fire handlers against the soon-to-be-new client.
  const oldClient = client;
  client = null;
  isLoggingOut = true;
  isReady = false;
  isReconnecting = false;
  allChats = [];
  currentQR = null;
  conversationMemory = {}; // don't carry a prior account's bot memory forward
  console.log("👋 User requested logout...");

  // Tear down the old session. logout() unlinks the device on the phone but
  // can hang, and destroy() must run before we touch the session folder
  // (Windows keeps file locks while the browser is alive). Time-box the whole
  // teardown so a stuck session can never block the fresh QR for more than a
  // few seconds.
  try {
    await Promise.race([
      (async () => {
        await oldClient.logout().catch(() => {});
        await oldClient.destroy().catch(() => {});
      })(),
      new Promise((resolve) => setTimeout(resolve, 6000)),
    ]);
  } catch (err) {
    console.log("⚠️ logout teardown warning:", err.message);
  }
  // Best-effort second destroy in case the race timed out mid-logout, so the
  // browser process is really gone and the auth folder unlocks for cleanup.
  try {
    await oldClient.destroy();
  } catch (_) {
    /* already destroyed */
  }

  // Rename the session folder out of the way (near-instant) so the new client
  // gets a clean slate and a fresh QR appears as fast as Chromium can boot.
  await cleanupAuthFolder();

  // A fresh logout->login is NOT a reconnect, so skip the long post-scan
  // stabilization delay (the new login does its own chat sync anyway).
  isLoggingOut = false;
  isReconnecting = false;

  console.log("🔄 Reinitializing WhatsApp client for next login...");
  initializeClient();
  client.initialize().catch((err) => {
    console.error("❌ Re-init error after logout:", err.message);
  });
});

// Bot configuration endpoints
const BOT_CONFIG_FILE = path.join(__dirname, "bot_config.json");

// Load bot config from file
function loadBotConfig() {
  try {
    if (fs.existsSync(BOT_CONFIG_FILE)) {
      const data = fs.readFileSync(BOT_CONFIG_FILE, "utf8");
      const loaded = JSON.parse(data);
      console.log(
        `📥 Loaded bot config: ${loaded.enabled ? "ENABLED" : "DISABLED"} for ${
          loaded.groups.length
        } groups`
      );
      return loaded;
    }
  } catch (err) {
    console.error("⚠️  Error loading bot config:", err.message);
  }
  return { enabled: false, groups: [] };
}

// Save bot config to file
function saveBotConfig(config) {
  try {
    fs.writeFileSync(BOT_CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`💾 Saved bot config to file`);
  } catch (err) {
    console.error("⚠️  Error saving bot config:", err.message);
  }
}

let botConfig = loadBotConfig();

// Bot personalities
const BOT_PERSONALITIES = {
  hyderabadi: {
    name: "Hyderabadi Friend",
    prompt: `You're a helpful Hyderabadi friend in a WhatsApp group. Balance personality with usefulness.

CORE BEHAVIOR:
✓ Answer questions DIRECTLY and CONCISELY first
✓ Add light Hyderabadi flavor naturally (arre, yaar, dekh, bhai)
✓ Keep responses SHORT: 1-3 sentences MAX
✓ Don't over-explain or give unnecessary details
✓ Mix Hindi/English naturally, don't force it

PERSONALITY LEVELS:
• Simple question → Quick answer + light touch: "Dekh bhai, it's X."
• Technical query → Clear answer first: "The solution is X. Arre, it's quite simple actually."
• Casual chat → More personality: "Kya baat hai yaar! All good here, you tell?"
• Past messages → Check timestamps: "Arre wait, checking what you said [time] ago..."

AVOID:
✗ Long explanations
✗ Repeating previous summaries
✗ Overusing Hyderabadi words
✗ Being vague or indirect`,
  },
  professional: {
    name: "Professional Assistant",
    prompt: `You're a professional American colleague providing efficient help in a WhatsApp group.

CORE BEHAVIOR:
✓ Provide DIRECT, ACCURATE answers immediately
✓ Be concise and solution-oriented
✓ Keep responses SHORT: 1-3 sentences MAX
✓ Use professional but friendly American English
✓ Focus on clarity and efficiency

PERSONALITY STYLE:
• Simple question → "Sure! The answer is X."
• Technical query → "Great question. Here's the solution: [direct answer]. Happy to clarify if needed."
• Casual chat → "Hey there! Doing well, thanks. How can I help?"
• Past messages → "Looking at our earlier discussion [time] ago..."

PHRASES TO USE (sparingly):
- "Sure thing"
- "Happy to help"
- "Here's what I'd suggest"
- "Let me clarify"

AVOID:
✗ Corporate jargon
✗ Long-winded explanations
✗ Repeating previous summaries
✗ Being overly formal`,
  },
  russian: {
    name: "Film & Anime Enthusiast",
    prompt: `You're a Gen Z film, anime, and cat enthusiast with encyclopedic knowledge chatting in WhatsApp.

CORE BEHAVIOR:
✓ Answer questions DIRECTLY first
✓ Add film/anime references when RELEVANT (don't force it)
✓ Keep responses SHORT: 1-3 sentences MAX
✓ Use Gen Z slang naturally
✓ Show genuine passion for cinema, anime, and cats

GEN Z SLANG (use moderately):
- "fr fr" / "no cap" / "lowkey" / "deadass"
- "hits different" / "peak fiction" / "slaps"
- "yooo" / "bro" / "ngl"

PERSONALITY STYLE:
• Simple question → "Deadass, the answer is X. Easy fr."
• Film/anime topic → "BRO! [Title] is peak fiction fr fr. [Quick detail]."
• Cats mentioned → "YOOO cats! Lowkey the best. Anyway, answer is..."
• Technical query → "Okay so basically, [direct answer]. Kinda like [brief reference] but simpler."
• Past messages → "Wait lemme check what we said [time] ago..."

AVOID:
✗ Forcing references
✗ Long reviews or explanations
✗ Overusing slang
✗ Repeating previous summaries`,
  },
  british: {
    name: "British Mate",
    prompt: `You're a cheerful British mate helping out in a WhatsApp group with proper English charm.

CORE BEHAVIOR:
✓ Give DIRECT, CLEAR answers immediately
✓ Add British flavor naturally (mate, brilliant, cheers, bloody)
✓ Keep responses SHORT: 1-3 sentences MAX
✓ Be friendly but efficient
✓ Use British spellings and phrases

PERSONALITY STYLE:
• Simple question → "Right, it's X. Sorted!"
• Technical query → "Brilliant question, mate. The answer is [direct answer]. Cheers!"
• Casual chat → "Alright mate? Doing well, thanks for asking!"
• Past messages → "Let me have a look at what you said [time] ago..."

BRITISH PHRASES (use moderately):
- "Cheers" / "Brilliant" / "Lovely"
- "Mate" / "Right then" / "Sorted"
- "Bloody" (for emphasis) / "Proper"

AVOID:
✗ Overdoing the accent
✗ Long-winded responses
✗ Stereotypical British clichés
✗ Repeating previous summaries`,
  },
  sarcastic: {
    name: "Sarcastic Helper",
    prompt: `You're a witty, sarcastic friend who helps despite the sass. You're helpful but can't resist a good quip.

CORE BEHAVIOR:
✓ Answer questions DIRECTLY (even if sarcastically)
✓ Add playful sarcasm without being mean
✓ Keep responses SHORT: 1-3 sentences MAX
✓ Be genuinely helpful despite the attitude
✓ Know when to drop the act (serious questions)

PERSONALITY STYLE:
• Simple question → "Oh wow, tough one. It's X. Mind blown, right?"
• Obvious question → "Let me consult my crystal ball... it's X. Shocking."
• Technical query → "Finally, a real question! Answer: [direct answer]."
• Serious topic → [Drop sarcasm] "Okay, seriously: [helpful answer]."
• Past messages → "*Scrolls back through our riveting chat history [time] ago*..."

SARCASM GUIDE:
- Use for simple/obvious questions
- Drop it for serious/personal topics
- Stay playful, never mean
- Always give the actual answer

AVOID:
✗ Being rude or hurtful
✗ Sarcasm on every message
✗ Long sarcastic rants
✗ Repeating previous summaries`,
  },
  chill: {
    name: "Chill Buddy",
    prompt: `You're the most laid-back, chill friend in the group. Nothing fazes you, everything's good vibes.

CORE BEHAVIOR:
✓ Give DIRECT answers in a relaxed way
✓ Stay calm and positive always
✓ Keep responses SHORT: 1-3 sentences MAX
✓ Use chill, relaxed language
✓ Spread good vibes

PERSONALITY STYLE:
• Simple question → "It's X, my dude. Easy peasy."
• Technical query → "No worries! Answer is [direct answer]. You got this."
• Stressed question → "Hey, chill. It's just X. All good, no stress."
• Casual chat → "Ayy what's good! Just vibing, you?"
• Past messages → "Lemme check what you dropped [time] ago..."

CHILL PHRASES:
- "No worries" / "All good" / "Easy"
- "My dude" / "Vibing" / "Chill"
- "You got this" / "No stress"

AVOID:
✗ Being too laid-back (still be helpful)
✗ Long explanations
✗ Anxiety or stress
✗ Repeating previous summaries`,
  },
};

// Pre-load conversation memory for bot-enabled groups
async function preloadBotMemory() {
  if (!isReady || !botConfig.enabled || botConfig.groups.length === 0) {
    return;
  }

  console.log("🧠 Pre-loading conversation memory for bot-enabled groups...");

  for (const groupInfo of botConfig.groups) {
    try {
      const chat = await client.getChatById(groupInfo.id);
      if (!chat || !chat.isGroup) continue;

      const chatId = chat.id._serialized;

      // Skip if already loaded
      if (conversationMemory[chatId] && conversationMemory[chatId].length > 0) {
        console.log(`   ⏭️ Memory already loaded for ${chat.name}`);
        continue;
      }

      console.log(`   📥 Loading last 50 messages for ${chat.name}...`);
      const messages = await chat.fetchMessages({ limit: 50 });

      conversationMemory[chatId] = [];

      for (const msg of messages.reverse()) {
        if (!msg.body || !msg.body.trim()) continue;

        try {
          let senderName = "User";
          if (msg.fromMe) {
            senderName = "Bot";
          } else if (msg.author) {
            const contact = await client.getContactById(msg.author);
            senderName =
              contact.pushname || contact.name || msg.author.split("@")[0];
          }

          conversationMemory[chatId].push({
            sender: senderName,
            text: msg.body,
            timestamp: msg.timestamp,
          });
        } catch (err) {
          // Skip messages we can't process
          continue;
        }
      }

      // Keep only last 50
      if (conversationMemory[chatId].length > 50) {
        conversationMemory[chatId] = conversationMemory[chatId].slice(-50);
      }

      console.log(
        `   ✅ Loaded ${conversationMemory[chatId].length} messages for ${chat.name}`
      );

      // Small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (err) {
      console.error(
        `   ❌ Error pre-loading memory for ${groupInfo.name}:`,
        err.message
      );
    }
  }

  console.log("✅ Bot memory pre-loading complete");
}

async function getBotConfig() {
  return botConfig;
}

app.get("/api/bot/config", (req, res) => {
  res.json(botConfig);
});

app.get("/api/bot/personalities", (req, res) => {
  // Return available personalities
  const personalities = Object.keys(BOT_PERSONALITIES).map((key) => ({
    id: key,
    name: BOT_PERSONALITIES[key].name,
  }));
  res.json({ personalities });
});

app.post("/api/bot/config", async (req, res) => {
  const { enabled, groups } = req.body;

  const wasEnabled = botConfig.enabled;
  const oldGroupIds = botConfig.groups.map((g) => g.id);

  if (typeof enabled !== "undefined") {
    botConfig.enabled = enabled;
  }

  if (Array.isArray(groups)) {
    // Ensure each group has a personality (default to hyderabadi)
    botConfig.groups = groups.slice(0, 3).map((g) => ({
      ...g,
      personality: g.personality || "hyderabadi",
    }));
  }

  // Save to file for persistence
  saveBotConfig(botConfig);

  console.log(
    `🤖 Bot config updated: ${botConfig.enabled ? "ENABLED" : "DISABLED"} for ${
      botConfig.groups.length
    } groups`
  );
  if (botConfig.enabled && botConfig.groups.length > 0) {
    console.log(
      `   Groups: ${botConfig.groups
        .map((g) => `${g.name} (${g.personality})`)
        .join(", ")}`
    );
  }

  // Pre-load memory if bot was just enabled or new groups added
  if (
    botConfig.enabled &&
    (!wasEnabled || botConfig.groups.some((g) => !oldGroupIds.includes(g.id)))
  ) {
    // Pre-load in background
    preloadBotMemory().catch((err) => {
      console.error("❌ Error pre-loading bot memory:", err.message);
    });
  }

  res.json({ success: true, config: botConfig });
});

// NEW: Endpoint to manually trigger memory pre-load for specific group
app.post("/api/bot/preload-memory", async (req, res) => {
  if (!isReady) {
    return res.status(503).json({ error: "WhatsApp not connected" });
  }

  const { groupId } = req.body;

  if (!groupId) {
    return res.status(400).json({ error: "groupId required" });
  }

  try {
    const groupInfo = botConfig.groups.find((g) => g.id === groupId);
    if (!groupInfo) {
      return res.status(404).json({ error: "Group not in bot config" });
    }

    console.log(`🧠 Manual memory pre-load requested for ${groupInfo.name}`);

    const chat = await client.getChatById(groupId);
    if (!chat || !chat.isGroup) {
      return res.status(400).json({ error: "Invalid group" });
    }

    const chatId = chat.id._serialized;

    // Load last 50 messages
    const messages = await chat.fetchMessages({ limit: 50 });
    conversationMemory[chatId] = [];

    for (const msg of messages.reverse()) {
      if (!msg.body || !msg.body.trim()) continue;

      try {
        let senderName = "User";
        if (msg.fromMe) {
          senderName = "Bot";
        } else if (msg.author) {
          const contact = await client.getContactById(msg.author);
          senderName =
            contact.pushname || contact.name || msg.author.split("@")[0];
        }

        conversationMemory[chatId].push({
          sender: senderName,
          text: msg.body,
          timestamp: msg.timestamp,
        });
      } catch (err) {
        continue;
      }
    }

    // Keep only last 50
    if (conversationMemory[chatId].length > 50) {
      conversationMemory[chatId] = conversationMemory[chatId].slice(-50);
    }

    console.log(
      `   ✅ Loaded ${conversationMemory[chatId].length} messages for ${chat.name}`
    );

    res.json({
      success: true,
      messagesLoaded: conversationMemory[chatId].length,
      groupName: chat.name,
    });
  } catch (err) {
    console.error("❌ Error pre-loading memory:", err.message);
    res.status(500).json({
      error: "Failed to pre-load memory",
      message: err.message,
    });
  }
});

// Polling mechanism to check for new messages in bot-enabled groups
async function checkBotMessages() {
  if (!isReady || !botConfig.enabled || botConfig.groups.length === 0) {
    return;
  }

  try {
    const myId = client.info.wid._serialized;

    for (const groupInfo of botConfig.groups) {
      try {
        const chat = await client.getChatById(groupInfo.id);
        if (!chat || !chat.isGroup) continue;

        // Fetch only last 3 messages (reduced from 5)
        const messages = await chat.fetchMessages({ limit: 3 });

        // Find the MOST RECENT mention (not all mentions)
        let mostRecentMention = null;

        for (const message of messages.reverse()) {
          // Process newest first
          // Skip if we sent this message
          if (message.fromMe) continue;

          // Skip messages from before bot started
          if (botStartTime && message.timestamp * 1000 < botStartTime) {
            continue;
          }

          // Skip if we've already processed this message (check global Set first)
          const messageId = message.id._serialized;
          if (processedMessages.has(messageId)) {
            continue; // Already processed by event handler
          }

          // Skip if we've already checked this in polling
          if (lastCheckedMessages[messageId]) continue;

          // Check if we're mentioned (respond to ANY mention in enabled groups)
          const mentionedIds = message.mentionedIds || [];
          const myNumber = String(myId).split("@")[0];
          const mentionedNumbers = mentionedIds.map(
            (id) => String(id).split("@")[0]
          );
          const isMentioned =
            mentionedIds.length > 0 || mentionedNumbers.includes(myNumber);

          // Check if it's a reply to our message
          let isReplyToMe = false;
          if (message.hasQuotedMsg) {
            try {
              const quotedMsg = await message.getQuotedMessage();
              isReplyToMe = quotedMsg.fromMe;
            } catch (e) {
              // Ignore errors fetching quoted message
            }
          }

          if (isMentioned || isReplyToMe) {
            mostRecentMention = message;
            break; // Found the most recent, stop looking
          }
        }

        // Only respond to the most recent mention
        if (!mostRecentMention) continue;

        const messageId = mostRecentMention.id._serialized;

        // Mark as checked in polling
        lastCheckedMessages[messageId] = Date.now();

        // Mark as processed globally to prevent event handler from also processing
        processedMessages.add(messageId);
        console.log(
          `🤖 [POLL] Bot triggered in ${chat.name} - message: ${messageId}`
        );

        // Check spam protection
        const canRespond = canBotRespond(chat.id._serialized);
        if (!canRespond.allowed) {
          console.log(`   🚫 [POLL] Rate limited - silently ignoring`);
          continue; // Silently ignore, don't send spam warning
        }

        // Generate AI response
        const model = getGeminiModel();
        if (!model) {
          await mostRecentMention.reply(
            "⚠️ AI engine unavailable. Check OLLAMA_HOSTS and that the Ollama server is running."
          );
          continue;
        }

        // Use conversation memory for this chat
        const chatId = chat.id._serialized;
        if (!conversationMemory[chatId]) {
          conversationMemory[chatId] = [];
        }

        const contact = await client.getContactById(mostRecentMention.from);

        // Add user message to memory FIRST
        conversationMemory[chatId].push({
          sender: contact.pushname || "User",
          text: mostRecentMention.body,
          timestamp: mostRecentMention.timestamp,
        });

        // Keep only last 50 messages
        if (conversationMemory[chatId].length > 50) {
          conversationMemory[chatId] = conversationMemory[chatId].slice(-50);
        }

        // Get stored conversation history (last 30 messages)
        const context = conversationMemory[chatId]
          .slice(-30)
          .map((msg) => `${msg.sender}: ${msg.text}`)
          .join("\n");

        console.log(
          `   💭 Using ${conversationMemory[chatId].length} messages from memory (showing last 30)`
        );

        // Get personality for this group
        const groupConfig = botConfig.groups.find(
          (g) => g.id === chat.id._serialized
        );
        const personalityKey = groupConfig?.personality || "hyderabadi";
        const personality = BOT_PERSONALITIES[personalityKey];

        console.log(`   🎭 Using personality: ${personality.name}`);

        const prompt = `${personality.prompt}

Recent conversation history (your memory):
${context}

Current question from ${contact.pushname || "User"}:
${mostRecentMention.body}

Respond naturally - prioritize being helpful. If they ask about previous messages or "last chat", refer to the conversation history above.`;

        console.log(`   🤖 Generating AI response...`);
        const result = await queueAIRequest(async () => {
          const model = getGeminiModel();
          return await retryWithBackoff(async (altModel) => {
            const useModel = altModel || model;
            return await useModel.generateContent(prompt);
          });
        }, 10); // High priority for bot responses

        const response = result.response.text();
        console.log(`   📤 Sending reply: ${response.substring(0, 100)}...`);

        // Add bot response to memory
        conversationMemory[chatId].push({
          sender: "Bot",
          text: response,
          timestamp: Date.now() / 1000,
        });

        // Keep only last 50 messages
        if (conversationMemory[chatId].length > 50) {
          conversationMemory[chatId] = conversationMemory[chatId].slice(-50);
        }

        // Record the response for spam protection
        recordBotResponse(chat.id._serialized);

        await mostRecentMention.reply(response);
        console.log(`✅ [POLL] Bot responded in ${chat.name}`);
      } catch (err) {
        console.warn(
          `⚠️ Error checking messages in ${groupInfo.name}:`,
          err.message
        );
      }
    }

    // Clean up old message IDs (keep only last hour)
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const key in lastCheckedMessages) {
      if (lastCheckedMessages[key] < oneHourAgo) {
        delete lastCheckedMessages[key];
        // Also remove from processedMessages Set
        processedMessages.delete(key);
      }
    }

    // Clean up processedMessages Set if it gets too large
    if (processedMessages.size > 200) {
      console.log(
        `🧹 Cleaning up processedMessages Set (size: ${processedMessages.size})`
      );
      // Remove messages that are no longer in lastCheckedMessages
      const validKeys = new Set(Object.keys(lastCheckedMessages));
      for (const msgId of processedMessages) {
        if (!validKeys.has(msgId)) {
          processedMessages.delete(msgId);
        }
      }
      console.log(`   Reduced to ${processedMessages.size} messages`);
    }
  } catch (err) {
    console.error("❌ Error in bot polling:", err);
  }
}

// Start polling every 10 seconds
setInterval(checkBotMessages, 10000);

// Serve built web UI when available. Falling back to the source folder keeps
// the endpoint useful before the first `npm run build`, but production should
// use whatsapp_ui/dist because Vite source modules are not served by Express.
const uiDistPath = path.join(__dirname, "whatsapp_ui", "dist");
const uiSourcePath = path.join(__dirname, "whatsapp_ui");
const uiStaticPath = fs.existsSync(uiDistPath) ? uiDistPath : uiSourcePath;

app.get("/", (req, res) => res.redirect("/ui/"));
app.get(["/whatsapp", "/wathsapp"], (req, res) =>
  res.redirect("/ui/whatsapp")
);

app.use("/ui", express.static(uiStaticPath));
app.use("/ui", (req, res, next) => {
  if (req.method !== "GET" || path.extname(req.path)) return next();

  const indexPath = path.join(uiStaticPath, "index.html");
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  return next();
});

// Start server
const PORT = 8002;

app.listen(PORT, () => {
  console.log("🚀 ContextAI WhatsApp Chat Analyzer");
  console.log("===================================");
  console.log(`📡 API Server: http://localhost:${PORT}`);
  console.log(`🌐 Web Interface: http://localhost:${PORT}/ui`);
  console.log("===================================");
  console.log("Team: Gear5");
  console.log("Made with ❤️ for hackathons\n");
  console.log("🔄 Initializing WhatsApp...\n");
});

// Initialize WhatsApp
initializeClient();

// Add error event listener
client.on("error", (error) => {
  console.error("❌ Client error:", error);
});

// Add remote_session_saved event
client.on("remote_session_saved", () => {
  console.log("💾 Remote session saved");
});

try {
  client.initialize().catch((err) => {
    console.error("❌ Initialization error:", err);
  });
} catch (err) {
  console.error("❌ Failed to start client:", err);
}

// Graceful shutdown
// IMPORTANT: do NOT delete the auth folder here - stopping the server must keep
// the saved session so the next start restores login without a new QR scan.
// (The session is only cleared on an explicit /api/logout.)
process.on("SIGINT", async () => {
  console.log("\n\n👋 Shutting down gracefully...");
  try {
    isLoggingOut = true;
    if (client) {
      await client.destroy();
    }
    console.log("✅ Shutdown complete (session preserved)");
  } catch (err) {
    console.log("⚠️ Shutdown warning:", err.message);
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n👋 Received SIGTERM...");
  isLoggingOut = true;
  if (client) {
    await client.destroy();
  }
  process.exit(0);
});

// Handle unhandled rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("❌ Uncaught Exception:", error);
});
