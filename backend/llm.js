/**
 * ContextAI - Shared Ollama LLM client
 * Team Gear5
 *
 * Single source of truth for all AI calls. Talks to one or more Ollama
 * servers running the Ollama Cloud `minimax-m3:cloud` model for text and
 * vision. Embeddings use `nomic-embed-text` when available, with a local
 * deterministic fallback so RAG remains usable on a fresh Ollama install.
 *
 * The exported model object intentionally mirrors the small slice of the
 * Google Generative AI interface the rest of the codebase already uses:
 *
 *     const model = createModel();
 *     const result = await model.generateContent(prompt);     // text
 *     const result = await model.generateContent([p, image]); // vision
 *     const text = result.response.text();
 *
 *     const e = await model.embedContent("hello");
 *     const vector = e.embedding.values;
 *
 * This keeps the migration off Gemini to a near drop-in replacement.
 *
 * Zero external dependencies - uses the global `fetch` (Node 18+).
 */

// --- Configuration (sensible defaults so it runs with no .env) ---
// Single-host local Ollama by default. Add more hosts (comma-separated) in
// backend/.env via OLLAMA_HOSTS for round-robin / failover, e.g.
//   OLLAMA_HOSTS=http://localhost:11434,http://gpu-box:11434
const HOSTS = (process.env.OLLAMA_HOSTS || "http://localhost:11434")
  .split(",")
  .map((h) => h.trim().replace(/\/+$/, ""))
  .filter(Boolean);

// Default text/vision model is the same as the locally installed Ollama model
// (see `ollama list`). Override with OLLAMA_TEXT_MODEL / OLLAMA_VISION_MODEL
// in backend/.env if you run something different.
const TEXT_MODEL = process.env.OLLAMA_TEXT_MODEL || "minimax-m3:cloud";
const VISION_MODEL = process.env.OLLAMA_VISION_MODEL || TEXT_MODEL;
const EMBED_MODEL =
  process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text:latest";
const ALLOW_LOCAL_EMBED_FALLBACK =
  process.env.OLLAMA_LOCAL_EMBED_FALLBACK !== "false";

// Cloud models can be slow on first token - keep a generous ceiling.
const REQUEST_TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || "180000", 10);

// --- Model availability cache (per host) ---
// hostModels[host] = Set of model names available on that host (or null if unknown).
const hostModels = {};
let tagsPromise = null;

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function loadTagsForHost(host) {
  try {
    const res = await fetchWithTimeout(`${host}/api/tags`, {}, 8000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    hostModels[host] = new Set((data.models || []).map((m) => m.name));
  } catch (err) {
    hostModels[host] = null; // unknown / unreachable
  }
}

function refreshTags() {
  tagsPromise = Promise.all(HOSTS.map(loadTagsForHost));
  return tagsPromise;
}

async function ensureTags() {
  if (!tagsPromise) refreshTags();
  await tagsPromise;
}

// Kick off availability discovery at startup (non-blocking).
refreshTags();
// Periodically refresh so a host coming online is picked up without a restart.
setInterval(refreshTags, 60000).unref?.();

/**
 * Build an ordered list of hosts to try for a given model.
 * A host is a candidate if it is known to have the model, or if its model
 * list is unknown yet (optimistic - the call will simply fail over).
 */
function hostsForModel(modelName, pinnedHost) {
  const has = (h) => {
    const set = hostModels[h];
    return set === null || set === undefined || set.has(modelName);
  };

  let candidates = HOSTS.filter(has);
  if (candidates.length === 0) candidates = [...HOSTS]; // last resort: try everything

  if (pinnedHost && candidates.includes(pinnedHost)) {
    // Pinned host first, the rest as failover targets.
    return [pinnedHost, ...candidates.filter((h) => h !== pinnedHost)];
  }
  if (pinnedHost && has(pinnedHost)) {
    return [pinnedHost, ...candidates.filter((h) => h !== pinnedHost)];
  }
  return candidates;
}

async function postJSON(host, path, body) {
  const res = await fetchWithTimeout(`${host}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Surface status codes so the callers' retryWithBackoff() can react.
    throw new Error(`Ollama ${host} ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Try each candidate host in order, failing over on error.
async function tryHosts(hosts, fn) {
  let lastError = null;
  for (const host of hosts) {
    try {
      return await fn(host);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("No Ollama hosts available");
}

/**
 * Generate text (optionally with images for vision).
 * Returns the model's `response` string with the reasoning trace stripped.
 */
async function generate({ prompt, images = [], pinnedHost, format, temperature }) {
  const useVision = images.length > 0;
  const model = useVision ? VISION_MODEL : TEXT_MODEL;
  const hosts = hostsForModel(model, pinnedHost);

  const body = {
    model,
    prompt,
    stream: false,
    options: {},
  };
  if (useVision) body.images = images;
  if (format) body.format = format;
  if (typeof temperature === "number") body.options.temperature = temperature;

  const data = await tryHosts(hosts, (host) =>
    postJSON(host, "/api/generate", body)
  );

  // minimax-m3 is a reasoning model: `thinking` is separate from `response`.
  return (data.response || "").trim();
}

async function embed({ text, pinnedHost }) {
  const hosts = hostsForModel(EMBED_MODEL, pinnedHost);
  try {
    const data = await tryHosts(hosts, (host) =>
      postJSON(host, "/api/embeddings", { model: EMBED_MODEL, prompt: text })
    );
    return data.embedding || [];
  } catch (err) {
    if (!ALLOW_LOCAL_EMBED_FALLBACK) throw err;
    console.warn(
      `⚠️ Ollama embedding model unavailable (${EMBED_MODEL}); using local fallback vectors.`
    );
    return localEmbedding(text);
  }
}

function localEmbedding(text, dims = 384) {
  const vector = new Array(dims).fill(0);
  const tokens = String(text || "")
    .toLowerCase()
    .match(/[a-z0-9_]+/g);

  if (!tokens || tokens.length === 0) return vector;

  for (const token of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const index = Math.abs(hash) % dims;
    vector[index] += 1;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm ? vector.map((value) => value / norm) : vector;
}

/**
 * Normalize a generateContent() argument into { prompt, images }.
 * Accepts a plain string, or a Gemini-style parts array:
 *   ["text", { inlineData: { data: <base64>, mimeType } }, ...]
 */
function normalizeInput(input) {
  if (typeof input === "string") return { prompt: input, images: [] };
  if (!Array.isArray(input)) return { prompt: String(input ?? ""), images: [] };

  const textParts = [];
  const images = [];
  for (const part of input) {
    if (typeof part === "string") {
      textParts.push(part);
    } else if (part && part.inlineData && part.inlineData.data) {
      images.push(part.inlineData.data); // base64, no data: prefix (Ollama wants raw b64)
    } else if (part && part.text) {
      textParts.push(part.text);
    }
  }
  return { prompt: textParts.join("\n\n"), images };
}

/**
 * Create a Gemini-compatible model handle.
 * @param {object} [opts]
 * @param {string} [opts.host] - pin this model to a specific Ollama host
 *   (the rest still act as failover). Used so callers can round-robin /
 *   cycle across hosts exactly like they used to cycle across API keys.
 */
function createModel(opts = {}) {
  const pinnedHost = opts.host || null;
  return {
    host: pinnedHost,
    async generateContent(input, callOpts = {}) {
      const { prompt, images } = normalizeInput(input);
      const text = await generate({
        prompt,
        images,
        pinnedHost,
        format: callOpts.format,
        temperature: callOpts.temperature,
      });
      return { response: { text: () => text } };
    },
    async embedContent(text) {
      const values = await embed({ text, pinnedHost });
      return { embedding: { values } };
    },
  };
}

/** Report engine + host/model availability (for status endpoints). */
async function getStatus() {
  // Force a fresh probe so the UI reflects the live state (a host that just
  // came back online shows as reachable immediately, not on the next 60s tick).
  await refreshTags();
  return {
    engine: "ollama",
    textModel: TEXT_MODEL,
    visionModel: VISION_MODEL,
    embedModel: EMBED_MODEL,
    localEmbedFallback: ALLOW_LOCAL_EMBED_FALLBACK,
    hosts: HOSTS.map((h) => ({
      host: h,
      reachable: hostModels[h] != null,
      models: hostModels[h] ? Array.from(hostModels[h]) : [],
    })),
  };
}

module.exports = {
  createModel,
  getStatus,
  refreshTags,
  HOSTS,
  TEXT_MODEL,
  VISION_MODEL,
  EMBED_MODEL,
};
