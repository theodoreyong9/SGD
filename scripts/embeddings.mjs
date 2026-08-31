// Real sentence embeddings via transformers.js (CPU/WASM, no GPU needed —
// this runs in a GitHub Actions runner, not a browser).
//
// This REPLACES the Jaccard-on-concepts heuristic used in the first version
// of process-graph.mjs. Two propositions phrased with entirely different
// vocabulary but the same meaning ("développer le rail" vs "investir dans
// le transport ferroviaire") now correctly show up as similar — Jaccard on
// extracted keywords could not see that unless the AI happened to extract
// identical concept words.
//
// NOTE ON TRUST: unlike canonical_key (scripts/canonical.mjs), embeddings
// are NOT used for identity/deduplication — only for the novelty/relation
// SCORING dimensions (spec sections 10-12, 21). A submission can never
// change what it canonically IS by way of its embedding; it can only affect
// how novel or well-connected it appears. That asymmetry is intentional:
// scoring can tolerate model drift between versions, identity cannot.

import { pipeline, env } from "@xenova/transformers";

// Keep the model cache inside the repo checkout so CI can cache it between
// runs (see .github/workflows/process-merge.yml's actions/cache step).
env.cacheDir = ".cache/transformers";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2"; // 384-dim, ~90MB, CPU-friendly

let extractorPromise = null;
function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", MODEL_ID);
  }
  return extractorPromise;
}

// embed(text) -> number[] (384-dim, L2-normalized, mean-pooled)
export async function embed(text) {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

// textForEmbedding(semantic): what we actually embed. Concepts carry most of
// the meaning; objective/means add the "why/how" that a bag of nouns loses.
export function textForEmbedding(semantic) {
  return [
    (semantic.concepts || []).join(", "),
    semantic.objective || "",
    semantic.means || "",
  ]
    .filter(Boolean)
    .join(". ");
}

export function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  // vectors are already L2-normalized by the pipeline, so dot product IS cosine similarity
  return dot;
}
