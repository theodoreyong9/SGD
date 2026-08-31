// Deterministic canonicalization: Canonical(S) = Hash(Encode(Normalize(S)))
// This file has NO dependency on any AI output itself — it only operates on
// the structured semantic representation {concepts, relations, objective,
// means, domain} it is given. What changed since this file was first
// written: S now comes from scripts/semantic-extract.mjs's OWN extraction
// of the submitted text, run server-side — never from a client-submitted
// structure. This function's determinism is what lets identical text
// produce the same canonical_key across resubmissions, even though the
// server's own LLM extraction isn't guaranteed to be byte-identical run to
// run; Normalize() absorbs small formatting drift (case, accents,
// whitespace, field order) but not genuine content drift.
//
// Used by scripts/semantic-extract.mjs (identity) and mirrored by
// src/semantic.js in the browser (for the non-authoritative live preview
// only) — keep the two in sync if you change this file.

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
