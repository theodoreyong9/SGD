// Server-side semantic extraction — the new source of truth for
// canonical_key.
//
// THE PROBLEM THIS SOLVES: until now, only the submitter's own browser
// ran the WebLLM extraction (src/semantic.js), and the server only
// reverified that canonical_key matched the `semantic` block declared
// by that same browser. That protects against a forged hash in
// isolation, but not against a hand-crafted `semantic` block unrelated
// to `text` while staying internally consistent with itself — the
// submitter is precisely the party whose extraction neutrality we
// wanted to guarantee. The validator can't detect this case: it's a
// perfectly valid JSON, structurally.
//
// This version eliminates the problem at the root rather than
// detecting it after the fact: scripts/validate-submission.mjs now
// reads ONLY `text` — any `semantic` block or `canonical_key` a client
// might still include is now simply, entirely ignored. It's THIS file
// that produces the authoritative structure, from the raw text alone
// (a string, not a structure that can be forged while keeping internal
// consistency).
//
// COST: GitHub Actions runners are free and unlimited on a public repo
// (same as scripts/embeddings.mjs) — no hidden bill. The real cost is
// latency: a CPU generation, even on a small model, can take several
// tens of seconds. Since processing an Issue is already asynchronous,
// this isn't blocking for anyone.
//
// The client-side WebLLM (src/semantic.js) stays in use for the
// instant PREVIEW before publication — the same AI/protocol separation
// as for embeddings: the client preview is never a guarantee, only
// this server-side extraction is authoritative.
//
// HONEST LIMIT: the model choice below (MODEL_ID) could not be
// validated under real conditions at the time this file was written —
// transformers.js and the availability of ONNX models compatible with
// a text-generation + chat-template pipeline evolve quickly. If
// extraction fails systematically in production, check this model name
// before suspecting the rest of the pipeline.

import { pipeline, env } from "@xenova/transformers";

env.cacheDir = ".cache/transformers";

// Compact instruction model, known to work with transformers.js's
// text-generation pipeline + messages (built-in chat template).
// Alternative to try if this one causes problems in CI:
// "Xenova/Qwen1.5-0.5B-Chat" (smaller, potentially less accurate).
const MODEL_ID = "Xenova/TinyLlama-1.1B-Chat-v1.0";

let generatorPromise = null;
function getGenerator() {
  if (!generatorPromise) generatorPromise = pipeline("text-generation", MODEL_ID);
  return generatorPromise;
}

// Copy of the prompt in src/semantic.js — the two MUST stay in sync. A
// divergence never affects identity (only THIS file is authoritative
// for canonical_key), only the consistency between the client preview
// and the final result — annoying for UX, not a protocol security
// issue.
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

// extractSemantic(text) -> { concepts, relations, objective, means, domain }
//
// Never throws for malformed JSON, an out-of-enum value, or a
// generation failure: falls back to a minimal extraction rather than
// failing the whole processing of a submission over a generation
// hiccup. A poor extraction simply yields a less informative node (few
// concepts, "other" domain, novelty probably high for lack of a match)
// — an acceptable degraded behavior, not a pipeline blocker.
export async function extractSemantic(text) {
  const generator = await getGenerator();

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: text },
  ];

  let raw = "";
  try {
    // IMPORTANT: with @xenova/transformers (the package pinned in
    // package.json, ^2.17.2 — distinct from the newer
    // @huggingface/transformers, which accepts an array of messages
    // directly), the text-generation pipeline does NOT accept `messages`
    // as-is. The prompt must first be built as text via the tokenizer's
    // chat template, then the generator called on that STRING. Calling
    // `generator(messages, ...)` directly — what the previous version of
    // this file did — produces unusable output without throwing an
    // error, which is why it fell back to the minimal extraction on
    // every submission, undetected until a real test under real
    // conditions (see README, "Known limits").
    const prompt = generator.tokenizer.apply_chat_template(messages, {
      tokenize: false,
      add_generation_prompt: true,
    });

    const output = await generator(prompt, {
      max_new_tokens: 300,
      do_sample: false,
      temperature: 0,
    });
    raw = output?.[0]?.generated_text ?? "";

    // Depending on the model's chat template, generated_text can include
    // the entire prompt (system + user) followed by the reply — keep
    // only what follows the original prompt.
    if (typeof raw === "string" && raw.startsWith(prompt)) {
      raw = raw.slice(prompt.length);
    }
  } catch (err) {
    console.warn("extractSemantic: generation failed, falling back to minimal —", err.message);
    return minimalFallback(text);
  }

  const jsonMatch = String(raw || "").match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn(
      "extractSemantic: no usable JSON in the output, falling back to minimal. Raw output (first 200 chars):",
      JSON.stringify(String(raw || "").slice(0, 200))
    );
    return minimalFallback(text);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    console.warn("extractSemantic: invalid JSON, falling back to minimal. Extracted block:", JSON.stringify(jsonMatch[0].slice(0, 200)));
    return minimalFallback(text);
  }

  const domainCandidate = normalizeEnum(parsed.domain);
  const domain = ALLOWED_DOMAINS.has(domainCandidate) ? domainCandidate : "other";

  const relations = (Array.isArray(parsed.relations) ? parsed.relations : [])
    .map((r) => ({
      type: normalizeEnum(r?.type),
      target_hint: String(r?.target_hint || "").slice(0, 200),
    }))
    .filter((r) => ALLOWED_RELATION_TYPES.has(r.type) && r.target_hint)
    .slice(0, 20);

  const concepts = (Array.isArray(parsed.concepts) ? parsed.concepts : [])
    .map((c) => String(c || "").slice(0, 60))
    .filter(Boolean)
    .slice(0, 20);

  if (concepts.length === 0) return minimalFallback(text);

  return {
    concepts,
    relations,
    objective: String(parsed.objective || "").slice(0, 300),
    means: String(parsed.means || "").slice(0, 300),
    domain,
  };
}

// Minimal fallback: a few meaningful words extracted mechanically from
// the raw text, without AI. Guarantees the pipeline always moves
// forward, at the cost of a less informative node — preferable to a
// total block.
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
