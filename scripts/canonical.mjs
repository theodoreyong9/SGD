// Deterministic canonicalization: Canonical(S) = Hash(Encode(Normalize(S)))
// This file has NO dependency on any AI output. It only operates on the
// structured semantic representation {concepts, relations, objective, means, domain}
// that the client already extracted. Determinism here is what lets the CI
// re-verify a client's claimed canonical_key without trusting the client's AI.
//
// Used both by scripts/validate-submission.mjs (Node, on CI) and mirrored by
// src/semantic.js (browser) — keep the two in sync if you change this file.

import { createHash } from "node:crypto";

function stripDiacritics(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeString(str) {
  return stripDiacritics(String(str || "").toLowerCase().trim())
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "");
}

// Normalize(S): lowercase, strip accents/punctuation, collapse whitespace,
// sort unordered collections so that equivalent content produces identical output
// regardless of the order the AI happened to emit fields in.
export function normalize(semantic) {
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

// Encode(Normalize(S)): stable, order-independent JSON serialization.
function encode(normalized) {
  return JSON.stringify(normalized, Object.keys(normalized).sort());
}

// Hash(...): sha256 hex digest, truncated to 32 chars for a manageable canonical_key.
export function canonicalKey(semantic) {
  const encoded = encode(normalize(semantic));
  return createHash("sha256").update(encoded).digest("hex").slice(0, 32);
}
