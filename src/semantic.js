// Semantic layer: text -> structured representation, for the LOCAL
// PREVIEW only.
//
// IMPORTANT CHANGE: this file no longer determines a submission's
// identity. The authoritative semantic extraction now runs server-side
// (scripts/semantic-extract.mjs, on the submitted `text` alone), to
// prevent a client from crafting a `semantic` block that's unrelated to
// its own text while staying internally consistent. `parseWithAI` and
// `canonicalKey` below therefore only ever drive a pre-publication
// preview (concepts, domain, closest existing proposition in the
// graph) — never sent to the server, never guaranteed to match what the
// server will produce for the same text.

let engine = null;
let loadingPromise = null;

const MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC"; // small enough for most laptops/phones

export async function loadModel(onProgress) {
  if (engine) return engine;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const webllm = await import(
      "https://esm.run/@mlc-ai/web-llm"
    );
    engine = await webllm.CreateMLCEngine(MODEL_ID, {
      initProgressCallback: (report) => onProgress?.(report),
    });
    return engine;
  })();

  return loadingPromise;
}

export function isModelLoaded() {
  return engine !== null;
}

export function isWebGPUAvailable() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}

const SYSTEM_PROMPT = `You are a deterministic, neutral semantic extractor.
Given a sentence submitted by a participant in a collective participation
space, output ONLY a JSON object (no surrounding text) with exactly
these keys:
{
  "concepts": [list of 1 to 6 short lowercase concepts, common nouns],
  "relations": [{"type": "one of: implies|contradicts|completes|generalizes|specializes|alternative_to|depends_on|questions", "target_hint": "concept or proposition targeted, short text"}],
  "objective": "what the proposition seeks to achieve, one short sentence",
  "means": "the concrete means proposed, one short sentence",
  "domain": "one of the EXACT following words, nothing else: environment, transport, energy, health, education, economy, technology, international, social, other"
}
Use "questions" when the sentence raises a question about a topic without
taking a stance ("How should this transition be funded?") — this is
neither agreement nor disagreement, and must stay distinguishable from both.
If the text is an interjection, a greeting, a filler word, or any
expression that CARRIES NO idea, position, objection, or question related
to a collective concern (for example "yo", "hi", "test", "lol", "ok", or
an isolated word unrelated to a matter of public concern), the domain
MUST be "other" and the concepts must faithfully describe what it is
("greeting", "interjection", "text without substance"...) — NEVER pick a
domain (health, energy, etc.) just because one has to be picked: text
without substance belongs to no real domain.
Output nothing but this JSON.`;

// These two lists MUST stay in sync with the ones in
// scripts/validate-submission.mjs (the server-side source of truth). A
// small local model like Llama-3.2-1B-Instruct doesn't always follow a
// closed-enum instruction to the letter — it can return a free-form
// phrase ("free candy consumption") instead of one of the expected
// values. Rather than letting an invalid value travel all the way to
// the GitHub Issue only to be rejected server-side — a full round trip
// for nothing — it's corrected here, right away, before a result is
// even shown to the user.
const ALLOWED_DOMAINS = new Set([
  "environment", "transport", "energy", "health", "education",
  "economy", "technology", "international", "social", "other",
]);
const ALLOWED_RELATION_TYPES = new Set([
  "implies", "contradicts", "completes", "generalizes", "specializes",
  "alternative_to", "depends_on", "questions",
]);

function normalizeEnum(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");
}

// Repairs the most common JSON mistakes made by a small local model
// (trailing comma before `]` or `}`) — far more frequent in practice
// than genuinely random JSON. Doesn't fix everything, just this one
// case, which is enough to avoid most of the failures observed in
// practice.
function repairTrailingCommas(jsonText) {
  return jsonText.replace(/,\s*([\]}])/g, "$1");
}

// Minimal fallback if the local model produces nothing usable at all —
// deliberately mirrors minimalFallback() in
// scripts/semantic-extract.mjs, for the same reason: this is only ever
// a PREVIEW (see file header), so a generation failure must never block
// the user, only degrade the preview shown.
function minimalFallback(text) {
  const words = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 3);
  return {
    concepts: words.length > 0 ? words : ["proposition"],
    relations: [],
    objective: "",
    means: "",
    domain: "other",
  };
}

// parseWithAI(text) -> { concepts, relations, objective, means, domain }
//
// Never throws for malformed or missing JSON: falls back to a minimal
// preview rather than breaking the whole submission flow. This is a
// preview (see file header) — a local-generation hiccup must never
// prevent the user from reaching publication, where only the server's
// own extraction actually counts.
export async function parseWithAI(text, onProgress) {
  const e = await loadModel(onProgress);
  const reply = await e.chat.completions.create({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
    temperature: 0, // determinism is not guaranteed by the model, but we minimize drift
    max_tokens: 400,
  });

  const raw = reply.choices[0].message.content.trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn("parseWithAI: no usable JSON in the model's output, falling back to minimal.");
    return minimalFallback(text);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    try {
      parsed = JSON.parse(repairTrailingCommas(jsonMatch[0]));
    } catch (e2) {
      console.warn("parseWithAI: invalid JSON even after repair, falling back to minimal —", e2.message);
      return minimalFallback(text);
    }
  }

  const domainCandidate = normalizeEnum(parsed.domain);
  const domain = ALLOWED_DOMAINS.has(domainCandidate) ? domainCandidate : "other";

  const relations = (Array.isArray(parsed.relations) ? parsed.relations : [])
    .map((r) => ({
      type: normalizeEnum(r?.type),
      target_hint: r?.target_hint || "",
    }))
    // A relation whose type is outside the allowed list is dropped rather
    // than reassigned at random: the model only produced one type out of
    // the 8 allowed, and there's no way to guess which one it meant.
    .filter((r) => ALLOWED_RELATION_TYPES.has(r.type) && r.target_hint);

  const concepts = Array.isArray(parsed.concepts) ? parsed.concepts : [];
  if (concepts.length === 0) return minimalFallback(text);

  return {
    concepts,
    relations,
    objective: parsed.objective || "",
    means: parsed.means || "",
    domain,
  };
}

// ---- Local canonicalization (mirrors scripts/canonical.mjs) ----
// WARNING: contrary to what this comment used to say before the move to
// server-side extraction, CI no longer recomputes or ever compares what
// this function produces — see the file header above. `canonicalKey`
// stays here only as a potentially useful utility (e.g. locally
// deduplicating several previews within one session), but nothing in
// the app uses it anymore to decide anything on the identity side. Kept
// in sync with scripts/canonical.mjs out of habit, not protocol necessity.

function stripDiacritics(str) {
  return str.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function normalizeString(str) {
  return stripDiacritics(String(str || "").toLowerCase().trim())
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "");
}

function normalize(semantic) {
  const concepts = (semantic.concepts || [])
    .map(normalizeString)
    .filter(Boolean)
    .sort();

  const relations = (semantic.relations || [])
    .map((r) => ({
      type: normalizeString(r.type),
      target_hint: normalizeString(r.target_hint),
    }))
    .sort((a, b) => (a.type + a.target_hint).localeCompare(b.type + b.target_hint));

  return {
    concepts,
    relations,
    objective: normalizeString(semantic.objective),
    means: normalizeString(semantic.means),
    domain: normalizeString(semantic.domain),
  };
}

function encode(normalized) {
  return JSON.stringify(normalized, Object.keys(normalized).sort());
}

async function sha256Hex(message) {
  const data = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function canonicalKey(semantic) {
  const encoded = encode(normalize(semantic));
  const full = await sha256Hex(encoded);
  return full.slice(0, 32);
}
