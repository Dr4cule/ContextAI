// ContextAI - RAG server (ingestion + retrieval)
// Team Gear5
//
// Extracts tasks/decisions/facts from incoming text, embeds them, and answers
// questions over the stored knowledge using Retrieval-Augmented Generation.
//
// AI engine: Ollama (minimax-m3:cloud + nomic-embed-text) via the shared
// backend/llm.js client. Storage: PostgreSQL + pgvector when DATABASE_URL is
// reachable, otherwise a built-in file-backed vector store (no DB required).

require("dotenv").config();

const express = require("express");
const cors = require("cors");

// Shared Ollama client (Gemini-compatible interface). It lives in backend/ and
// has no dependencies of its own, so requiring it across packages is safe.
const { createModel, getStatus } = require("../backend/llm");
const { FileVectorStore } = require("./vectorStore");

const aiModel = createModel(); // unpinned: uses all OLLAMA_HOSTS with failover

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// --- Storage layer (Postgres optional, file store fallback) ---

class PgVectorStore {
  constructor(pool) {
    this.pool = pool;
  }
  get kind() {
    return "postgres";
  }
  async insert({ project_id, team_id, source, event_data, embedding }) {
    const embeddingString = `[${embedding.join(",")}]`;
    await this.pool.query(
      `INSERT INTO events (project_id, team_id, source, event_data, embedding)
       VALUES ($1, $2, $3, $4, $5)`,
      [project_id, team_id, source, event_data, embeddingString]
    );
  }
  async search(project_id, team_id, queryEmbedding, limit = 5) {
    const questionEmbedding = `[${queryEmbedding.join(",")}]`;
    const params = [project_id, questionEmbedding];
    let query = `
      SELECT event_data, timestamp, 1 - (embedding <-> $2) AS similarity
      FROM events
      WHERE project_id = $1`;
    if (team_id) {
      query += ` AND team_id = $3`;
      params.push(team_id);
    }
    const safeLimit = Math.max(1, Math.min(50, limit));
    query += ` ORDER BY similarity DESC LIMIT ${safeLimit}`;
    const result = await this.pool.query(query, params);
    return result.rows;
  }
  async count() {
    try {
      const r = await this.pool.query("SELECT COUNT(*)::int AS n FROM events");
      return r.rows[0].n;
    } catch (_) {
      return undefined;
    }
  }
}

let store = new FileVectorStore();

async function initStorage() {
  if (process.env.DATABASE_URL) {
    try {
      const { Pool } = require("pg");
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      await pool.query("SELECT 1");
      store = new PgVectorStore(pool);
      console.log("🗄️  RAG storage: PostgreSQL (pgvector)");
      return;
    } catch (err) {
      console.warn(
        "⚠️  DATABASE_URL set but Postgres unavailable - falling back to file store:",
        err.message
      );
    }
  }
  const n = await store.count();
  console.log(`🗄️  RAG storage: file-backed JSON (${n} events loaded)`);
}

// Robustly parse a JSON array out of an LLM response.
function parseEvents(text) {
  const cleaned = (text || "")
    .replaceAll("```json", "")
    .replaceAll("```", "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    // Try to salvage the first [...] block.
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        /* fall through */
      }
    }
    return [];
  }
}

// --- INGESTION ---

app.post("/api/v1/ingest", async (req, res) => {
  try {
    const { project_id, team_id, source, text } = req.body;
    if (!project_id || !team_id || !text) {
      return res
        .status(400)
        .json({ error: "Missing project_id, team_id, or text" });
    }
    console.log(`Received data for project: ${project_id}`);

    // STEP 1: AI Analysis - extract structured events
    console.log("Sending text to AI for analysis...");
    const extractionPrompt = `
      Analyze the following text. Extract any tasks, decisions, or important facts
      as a JSON array.
      - Tasks should have a "type": "TASK" and "content".
      - Decisions should have a "type": "DECISION" and "content".
      - Facts should have a "type": "FACT" and "content".
      - If no specific event is found, return an empty array [].
      Respond with ONLY the JSON array, no prose.
      Text to analyze: "${text}"
    `;
    const result = await aiModel.generateContent(extractionPrompt, {
      format: "json",
      temperature: 0.2,
    });
    const events = parseEvents(result.response.text());

    if (events.length === 0) {
      console.log("AI found no events. Nothing to save.");
      return res.status(200).json({ message: "No events found in text." });
    }
    console.log(`AI found ${events.length} event(s). Processing...`);

    // STEPS 2 & 3: Embed & Save
    for (const event of events) {
      const contentToEmbed = event.content || JSON.stringify(event);
      console.log(`Embedding content: "${contentToEmbed}"`);
      const embeddingResult = await aiModel.embedContent(contentToEmbed);
      const embedding = embeddingResult.embedding.values;

      await store.insert({
        project_id,
        team_id,
        source,
        event_data: event,
        embedding,
      });
      console.log("Event saved successfully!");
    }
    res.status(200).json({
      message: `Successfully processed and saved ${events.length} event(s).`,
      savedEvents: events,
    });
  } catch (error) {
    console.error("Error in /ingest endpoint:", error);
    res.status(500).json({ error: "Failed to process data" });
  }
});

// --- RETRIEVAL ---

app.post("/api/v1/ask", async (req, res) => {
  try {
    const { project_id, team_id, question } = req.body;
    if (!project_id || !question) {
      return res.status(400).json({ error: "Missing project_id or question" });
    }
    console.log(`New question for project ${project_id}: "${question}"`);

    // 1. Embed the question
    console.log("Embedding the question...");
    const embeddingResult = await aiModel.embedContent(question);
    const questionEmbedding = embeddingResult.embedding.values;

    // 2. Retrieve the most relevant events
    console.log("Searching for relevant context...");
    const rows = await store.search(project_id, team_id, questionEmbedding, 5);

    // Order chronologically so the model reads context in sequence.
    rows.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    if (rows.length === 0) {
      console.log("No context found.");
      return res.status(200).json({
        answer:
          "I'm sorry, I couldn't find any information relevant to your question.",
      });
    }

    // 3. Build a grounded prompt
    console.log("Building prompt with context...");
    let context = "Context:\n";
    for (const row of rows) {
      context += `- ${JSON.stringify(row.event_data)}\n`;
    }

    const finalPrompt = `
      ${context}

      User's Question: "${question}"

      Based *only* on the context provided above, answer the user's question.
      If the context doesn't contain the answer, say you couldn't find the information.
    `;

    // 4. Generate the answer
    console.log("Generating final answer...");
    const result = await aiModel.generateContent(finalPrompt, {
      temperature: 0.3,
    });
    const answer = result.response.text();

    console.log("Answer generated:", answer);
    res.status(200).json({ answer });
  } catch (error) {
    console.error("Error in /ask endpoint:", error);
    res.status(500).json({ answer: "Failed to answer question" });
  }
});

// --- Health / status ---

app.get("/health", async (req, res) => {
  let ai = null;
  try {
    ai = await getStatus();
  } catch (err) {
    ai = { engine: "ollama", error: err.message };
  }
  res.json({
    status: "ok",
    storage: store.kind,
    events: store.count ? await store.count() : undefined,
    ai,
  });
});

app.get("/", (req, res) => {
  res.send("ContextAI RAG server is running.");
});

initStorage().finally(() => {
  app.listen(PORT, () => {
    console.log("🚀 ContextAI RAG Server");
    console.log("===================================");
    console.log(`📡 API: http://localhost:${PORT}`);
    console.log("===================================");
  });
});
