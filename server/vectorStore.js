/**
 * ContextAI - File-backed vector store (no-database fallback)
 * Team Gear5
 *
 * A tiny, dependency-free vector store so the RAG server runs out of the box
 * without PostgreSQL/pgvector. Events are persisted as JSON on disk and
 * searched in-memory with cosine similarity.
 *
 * Exposes the same shape the RAG server expects from its storage layer:
 *   await store.insert({ project_id, team_id, source, event_data, embedding })
 *   await store.search(project_id, team_id, queryEmbedding, limit)
 *     -> [{ event_data, timestamp, similarity }]
 */

const fs = require("fs");
const path = require("path");

const STORE_FILE =
  process.env.RAG_STORE_FILE || path.join(__dirname, "rag_store.json");

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

class FileVectorStore {
  constructor(file = STORE_FILE) {
    this.file = file;
    this.events = [];
    this._load();
  }

  get kind() {
    return "file";
  }

  _load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, "utf8");
        this.events = JSON.parse(raw || "[]");
        if (!Array.isArray(this.events)) this.events = [];
      }
    } catch (err) {
      console.warn("⚠️ Could not read RAG store, starting empty:", err.message);
      this.events = [];
    }
  }

  _persist() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.events, null, 2));
    } catch (err) {
      console.error("❌ Failed to persist RAG store:", err.message);
    }
  }

  async insert({ project_id, team_id, source, event_data, embedding }) {
    this.events.push({
      project_id,
      team_id: team_id || null,
      source: source || null,
      event_data,
      embedding,
      timestamp: new Date().toISOString(),
    });
    this._persist();
  }

  async search(project_id, team_id, queryEmbedding, limit = 5) {
    const scored = this.events
      .filter((e) => e.project_id === project_id)
      .filter((e) => (team_id ? e.team_id === team_id : true))
      .map((e) => ({
        event_data: e.event_data,
        timestamp: e.timestamp,
        similarity: cosineSimilarity(queryEmbedding, e.embedding),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
    return scored;
  }

  async count() {
    return this.events.length;
  }
}

module.exports = { FileVectorStore, cosineSimilarity };
