/**
 * ContextAI - Discord Bot Backend
 * Team Gear5
 */

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { Client, GatewayIntentBits } = require("discord.js");
const { createModel, getStatus, HOSTS, TEXT_MODEL } = require("./llm");

require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// RAG Server Integration
const INGEST_SERVER_URL = "http://localhost:3000/api/v1/ingest";
const DISCORD_MAPPING_FILE = path.join(__dirname, "discord_mapping.json");

// Load Discord-to-Project mapping
let discordMapping = {};
if (fs.existsSync(DISCORD_MAPPING_FILE)) {
  try {
    discordMapping = JSON.parse(fs.readFileSync(DISCORD_MAPPING_FILE, "utf8"));
    console.log(
      `📋 Loaded ${Object.keys(discordMapping).length} Discord channel mappings`
    );
  } catch (err) {
    console.warn("⚠️ Failed to load discord_mapping.json:", err.message);
  }
} else {
  console.log("📋 No discord_mapping.json found - RAG features disabled");
}

// Storage directory for Discord summaries
const SUMMARIES_DIR = path.join(__dirname, "contextai_discord_summaries");
if (!fs.existsSync(SUMMARIES_DIR)) {
  fs.mkdirSync(SUMMARIES_DIR, { recursive: true });
}

// Initialize the AI engine: Ollama (minimax-m3:cloud), one handle per
// host for round-robin load balancing with cross-host failover.
const geminiModels = HOSTS.map((host) => createModel({ host }));
let currentModelIndex = 0;

if (geminiModels.length === 0) {
  console.warn("⚠️ No OLLAMA_HOSTS configured - AI analysis disabled");
} else {
  HOSTS.forEach((host, index) => {
    console.log(`🤖 Ollama AI #${index + 1} -> ${host} (${TEXT_MODEL})`);
  });
  console.log(`✅ Total active Ollama hosts: ${geminiModels.length}`);
}

function getGeminiModel() {
  if (geminiModels.length === 0) return null;
  currentModelIndex = (currentModelIndex + 1) % geminiModels.length;
  console.log(
    `   🔄 Using Ollama host #${currentModelIndex + 1} of ${geminiModels.length}`
  );
  return geminiModels[currentModelIndex];
}

// AI engine status endpoint (Ollama hosts + models)
app.get("/api/ai/status", async (req, res) => {
  try {
    res.json(await getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Retry helper for API calls with exponential backoff
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 2000) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isRetryable =
        error.message.includes("503") ||
        error.message.includes("500") ||
        error.message.includes("overloaded") ||
        error.message.includes("429") ||
        error.message.includes("RESOURCE_EXHAUSTED") ||
        error.message.includes("fetch failed") ||
        error.message.includes("ECONNREFUSED") ||
        error.message.includes("ECONNRESET") ||
        error.message.includes("ETIMEDOUT") ||
        error.message.includes("socket hang up") ||
        error.message.includes("aborted");

      if (attempt === maxRetries || !isRetryable) {
        throw lastError;
      }

      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(
        `⚠️ API error (attempt ${attempt}/${maxRetries}), retrying in ${
          delay / 1000
        }s...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// Initialize Discord Bot
// The bot token can come from the environment OR be supplied at runtime via
// POST /api/connect (so a user can paste their token straight into the UI).
let discordClient = null;
let isDiscordReady = false;
let isConnecting = false;
let connectError = null;
let guildsCache = [];
let channelsCache = {};

function attachHandlers(client) {
  client.once("ready", () => {
    console.log(`✅ Discord Bot logged in as ${client.user.tag}`);
    isDiscordReady = true;
    isConnecting = false;
    connectError = null;

    // Cache guilds and channels
    guildsCache = Array.from(client.guilds.cache.values()).map((guild) => ({
      id: guild.id,
      name: guild.name,
      icon: guild.iconURL(),
      memberCount: guild.memberCount,
    }));

    guildsCache.forEach((guild) => {
      const guildObj = client.guilds.cache.get(guild.id);
      channelsCache[guild.id] = Array.from(guildObj.channels.cache.values())
        .filter((ch) => ch.type === 0) // Only GuildText channels
        .map((ch) => ({ id: ch.id, name: ch.name, type: ch.type }));
    });

    console.log(`📡 Connected to ${guildsCache.length} servers`);
  });

  // Auto-ingest Discord messages to RAG
  client.on("messageCreate", async (message) => {
    try {
      if (message.author.bot) return;
      if (message.channel.type !== 0) return;

      const channelKey = `${message.guildId}_${message.channelId}`;
      const mapping = discordMapping[channelKey];

      if (mapping && message.content) {
        console.log(
          `[DISCORD-INGEST] Channel ${channelKey} IS mapped. Sending to RAG server...`
        );
        const payload = {
          project_id: mapping.project_id,
          team_id: mapping.team_id,
          source: "discord",
          text: message.content,
        };
        axios
          .post(INGEST_SERVER_URL, payload)
          .then(() =>
            console.log(
              `[DISCORD-INGEST] SUCCESS: Sent message from ${message.channel.name} to RAG server.`
            )
          )
          .catch((err) =>
            console.error(
              "[DISCORD-INGEST] FAILED to send to RAG server:",
              err.message
            )
          );
      }
    } catch (err) {
      console.error(
        "[DISCORD-INGEST] Error processing message for ingestion:",
        err
      );
    }
  });

  client.on("error", (error) => {
    console.error("❌ Discord client error:", error);
  });
}

/**
 * Connect (or reconnect) to Discord with the given token.
 * Creates a fresh client each time so a bad-token attempt can be retried
 * with a corrected token without restarting the process.
 */
async function connectDiscord(token) {
  if (!token || typeof token !== "string" || !token.trim()) {
    throw new Error("A Discord bot token is required");
  }
  if (isConnecting) {
    throw new Error("Already attempting to connect - please wait");
  }

  // Tear down any previous client.
  if (discordClient) {
    try {
      await discordClient.destroy();
    } catch (_) {
      /* ignore */
    }
  }

  isConnecting = true;
  isDiscordReady = false;
  connectError = null;
  guildsCache = [];
  channelsCache = {};

  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  attachHandlers(discordClient);

  try {
    await discordClient.login(token.trim());
    // `login` resolves once the token is accepted; the "ready" event flips
    // isDiscordReady shortly after as the guild cache populates.
  } catch (err) {
    isConnecting = false;
    connectError = err.message || "Login failed";
    console.error("❌ Failed to login to Discord:", connectError);
    throw err;
  }
}

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
if (DISCORD_TOKEN) {
  connectDiscord(DISCORD_TOKEN).catch(() => {
    /* error already logged + stored in connectError */
  });
} else {
  console.warn(
    "⚠️  DISCORD_BOT_TOKEN not set - the Discord page will prompt for a bot token. " +
      "You can also add DISCORD_BOT_TOKEN to backend/.env."
  );
}

// API Endpoints

// Get Discord bot status
app.get("/api/status", (req, res) => {
  res.json({
    ready: isDiscordReady,
    connecting: isConnecting,
    // "configured" tells the UI whether a token has ever been supplied.
    configured: Boolean(discordClient),
    error: connectError,
    user:
      isDiscordReady && discordClient?.user
        ? {
            id: discordClient.user.id,
            username: discordClient.user.username,
            tag: discordClient.user.tag,
            avatar: discordClient.user.displayAvatarURL(),
          }
        : null,
    guilds: guildsCache.length,
  });
});

// Connect to Discord at runtime with a user-supplied bot token.
app.post("/api/connect", async (req, res) => {
  const { token } = req.body || {};
  try {
    await connectDiscord(token);
    res.json({
      success: true,
      message: "Token accepted - connecting to Discord...",
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Get all servers (guilds)
app.get("/api/guilds", (req, res) => {
  if (!isDiscordReady) {
    return res.status(503).json({ error: "Discord bot not ready" });
  }

  res.json({ guilds: guildsCache });
});

// Get channels for a specific guild
app.get("/api/guilds/:guildId/channels", (req, res) => {
  const { guildId } = req.params;

  if (!isDiscordReady) {
    return res.status(503).json({ error: "Discord bot not ready" });
  }

  const channels = channelsCache[guildId] || [];
  res.json({ channels });
});

// Analyze channel messages
app.post("/api/analyze", async (req, res) => {
  try {
    const {
      guildId,
      channelId,
      analysisDepth = "moderate",
      messageLimit = 100,
    } = req.body;

    if (!guildId || !channelId) {
      return res.status(400).json({ error: "guildId and channelId required" });
    }

    if (!isDiscordReady) {
      return res.status(503).json({ error: "Discord bot not ready" });
    }

    const guild = discordClient.guilds.cache.get(guildId);
    if (!guild) {
      return res.status(404).json({ error: "Guild not found" });
    }

    const channel = guild.channels.cache.get(channelId);
    if (!channel) {
      return res.status(404).json({ error: "Channel not found" });
    }

    console.log(`📊 Analyzing #${channel.name} in ${guild.name}...`);

    // Fetch messages
    const messages = await channel.messages.fetch({
      limit: Math.min(messageLimit, 100),
    });
    const messageArray = Array.from(messages.values()).reverse();

    if (messageArray.length === 0) {
      return res.status(400).json({ error: "No messages found in channel" });
    }

    // Format messages for analysis
    const formattedMessages = messageArray
      .map((msg) => {
        const timestamp = msg.createdAt.toLocaleString();
        const author = msg.author.username;
        const content = msg.content || "[Attachment/Embed]";
        return `[${timestamp}] ${author}: ${content}`;
      })
      .join("\n");

    // Get AI model
    const model = getGeminiModel();
    if (!model) {
      return res.status(503).json({ error: "AI not configured" });
    }

    const isDeepAnalysis = analysisDepth === "deep";

    let prompt;
    if (isDeepAnalysis) {
      prompt = `Analyze this Discord channel conversation in DEEP RESEARCH mode:

Server: ${guild.name}
Channel: #${channel.name}
Messages analyzed: ${messageArray.length}

Conversation:
${formattedMessages}

Provide an IN-DEPTH analysis with:
**📊 Deep Context Analysis**
* Overall purpose and background
* Community dynamics

**📋 Detailed Topics & Themes**
* Main topics with context
* Technical discussions
* Connections between topics

**✅ Decisions & Reasoning**
* Decisions made with reasoning
* Impact and implications

**📌 Action Items & Dependencies**
* Tasks with owners and deadlines

**👥 Active Participants**
* Key contributors and roles

**💡 Critical Insights**
* Important moments with deeper meaning

**🔍 Patterns & Predictions**
* Recurring themes
* Community health indicators

Keep well-structured with clear bullet points.`;
    } else {
      prompt = `Analyze this Discord channel conversation and provide a concise summary:

Server: ${guild.name}
Channel: #${channel.name}
Messages analyzed: ${messageArray.length}

Conversation:
${formattedMessages}

Provide a summary with:
**📊 Overview**
* Main purpose and context

**📋 Key Topics**
* Important topics discussed

**✅ Decisions & Action Items**
* Decisions made and next steps

**👥 Active Participants**
* Key contributors

**💡 Highlights**
* Notable quotes or moments

Keep it concise and well-structured.`;
    }

    console.log(`🤖 Analyzing with Ollama AI (${analysisDepth} mode)...`);

    const result = await retryWithBackoff(
      async () => await model.generateContent(prompt),
      3,
      2000
    );

    const response = await result.response;
    const summary = response.text();

    // Save summary
    const summaryId = `discord_${guildId}_${channelId}_${Date.now()}`;
    const summaryData = {
      id: summaryId,
      guildId,
      guildName: guild.name,
      channelId,
      channelName: channel.name,
      messageCount: messageArray.length,
      summary,
      analysisDepth,
      messageLimit,
      analyzedAt: new Date().toISOString(),
    };

    fs.writeFileSync(
      path.join(SUMMARIES_DIR, `${summaryId}.json`),
      JSON.stringify(summaryData, null, 2)
    );

    // Save to dashboard summaries
    const dashboardSummary = {
      chatId: summaryId,
      chatName: `#${channel.name} (${guild.name})`,
      summary: summary,
      stats: {
        messageCount: messageArray.length,
        server: guild.name,
        channel: channel.name,
        date: new Date().toISOString(),
      },
      source: "discord",
      timestamp: new Date().toISOString(),
    };

    const summariesPath = path.join(__dirname, "summaries.json");
    let allSummaries = [];
    try {
      if (fs.existsSync(summariesPath)) {
        const data = fs.readFileSync(summariesPath, "utf8");
        allSummaries = JSON.parse(data);
      }
    } catch (err) {
      allSummaries = [];
    }

    allSummaries = allSummaries.filter((s) => s.chatId !== summaryId);
    allSummaries.unshift(dashboardSummary);
    fs.writeFileSync(summariesPath, JSON.stringify(allSummaries, null, 2));

    console.log(`✅ Analysis complete and saved to dashboard`);
    res.json({ success: true, summary, summaryId });
  } catch (err) {
    console.error("Analysis error:", err);
    res.status(500).json({ error: "Analysis failed", message: err.message });
  }
});

// Q&A on channel - NOW POWERED BY RAG SERVER
app.post("/api/qa", async (req, res) => {
  try {
    const { summaryId, question, guildId, channelId } = req.body;

    if (!question) {
      return res.status(400).json({ error: "question required" });
    }

    console.log(`[DISCORD-RAG] New Q&A Request`);
    console.log(`[DISCORD-RAG] Question: ${question}`);

    // Check if we have RAG mapping for this channel
    const channelKey = `${guildId}_${channelId}`;
    const mapping = discordMapping[channelKey];

    if (mapping) {
      // Use RAG server for mapped channels
      console.log(
        `[DISCORD-RAG] Channel ${channelKey} is mapped. Using RAG server...`
      );

      const ragPayload = {
        project_id: mapping.project_id,
        team_id: mapping.team_id,
        question: question,
      };

      try {
        const ragResponse = await axios.post(
          "http://localhost:3000/api/v1/ask",
          ragPayload
        );

        console.log("[DISCORD-RAG] Answer generated from RAG server");
        return res.json({
          success: true,
          question: question,
          answer: ragResponse.data.answer,
        });
      } catch (err) {
        console.error("❌ DISCORD-RAG Error:", err.message);
        // Fall back to Ollama if RAG fails
      }
    }

    // Fallback: Use Ollama with summary (for unmapped channels or if RAG fails)
    if (!summaryId) {
      return res
        .status(400)
        .json({ error: "summaryId required for non-RAG channels" });
    }

    const filePath = path.join(SUMMARIES_DIR, `${summaryId}.json`);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Summary not found" });
    }

    const summaryData = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const model = getGeminiModel();

    if (!model) {
      return res.status(503).json({ error: "AI not configured" });
    }

    console.log("[DISCORD-RAG] Using Ollama fallback with summary...");
    const prompt = `Discord Channel: #${summaryData.channelName} in ${summaryData.guildName}

Summary:
${summaryData.summary}

Question: ${question}

Provide a concise, direct answer based on the summary. If the information isn't in the summary, say so.`;

    const result = await retryWithBackoff(
      async () => await model.generateContent(prompt),
      3,
      2000
    );

    const response = await result.response;
    const answer = response.text();

    res.json({ success: true, question, answer });
  } catch (err) {
    console.error("Q&A error:", err);
    res.status(500).json({ error: "Q&A failed", message: err.message });
  }
});

// Delete summary
app.delete("/api/summaries/:summaryId", (req, res) => {
  try {
    const { summaryId } = req.params;
    const filePath = path.join(SUMMARIES_DIR, `${summaryId}.json`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Summary not found" });
    }

    fs.unlinkSync(filePath);
    console.log(`🗑️ Deleted summary: ${summaryId}`);
    res.json({ success: true });
  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).json({ error: "Delete failed" });
  }
});

// Get all summaries
app.get("/api/summaries", (req, res) => {
  try {
    const files = fs
      .readdirSync(SUMMARIES_DIR)
      .filter((f) => f.endsWith(".json"));
    const summaries = files
      .map((file) => {
        const data = JSON.parse(
          fs.readFileSync(path.join(SUMMARIES_DIR, file), "utf8")
        );
        return {
          id: data.id,
          guildName: data.guildName,
          channelName: data.channelName,
          messageCount: data.messageCount,
          analyzedAt: data.analyzedAt,
          summary: data.summary,
        };
      })
      .sort((a, b) => new Date(b.analyzedAt) - new Date(a.analyzedAt));

    res.json({ summaries });
  } catch (err) {
    console.error("Error loading summaries:", err);
    res.status(500).json({ error: "Failed to load summaries" });
  }
});

const PORT = 8004;

app.listen(PORT, () => {
  console.log("🚀 ContextAI Discord Analyzer");
  console.log("===================================");
  console.log(`📡 API Server: http://localhost:${PORT}`);
  console.log("===================================");
  console.log("Team: Gear5\n");
});
