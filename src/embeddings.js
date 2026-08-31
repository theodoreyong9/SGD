// Browser-side embeddings for the LIVE PREVIEW only (finding the closest
// existing node to show the user before they publish). This is UX, not
// identity or authoritative scoring — the real novelty/bridge/stability
// numbers are always recomputed server-side in scripts/process-graph.mjs
// after merge, using the same model, but that recomputation is what's
// trusted, never this one (spec section 35: séparation IA / protocole).
//
// Runs on WASM, so it works even where WebGPU (needed for the WebLLM chat
// model in semantic.js) is unavailable.

let extractorPromise = null;

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import("https://esm.run/@xenova/transformers");
      return pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    })();
  }
  return extractorPromise;
}

export async function embed(text) {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

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
  return dot;
}
