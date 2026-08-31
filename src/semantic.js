// Semantic layer: text -> structured representation -> deterministic canonical key.
//
// Split per section 35 of the spec ("Séparation IA / protocole"):
//   - parseWithAI()   : probabilistic, does the actual language understanding
//   - canonicalKey()  : deterministic, re-verifiable by the CI with zero AI
//
// The AI's job is ONLY to extract structure. It is never trusted to decide
// scores, novelty, or identity — those are recomputed server-side in
// scripts/process-graph.mjs from the deterministic canonical_key.

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

export function isWebGPUAvailable() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}

const SYSTEM_PROMPT = `Tu es un extracteur sémantique déterministe et neutre.
Étant donné une phrase soumise par un participant à un espace de participation
collective, produis UNIQUEMENT un objet JSON (aucun texte autour) avec exactement
ces clés :
{
  "concepts": [liste de 1 à 6 concepts courts en minuscules, noms communs],
  "relations": [{"type": "un des: implique|contredit|complete|generalise|specialise|alternative_a|depend_de|questionne", "target_hint": "concept ou proposition visée, texte court"}],
  "objectif": "ce que la proposition cherche à obtenir, une phrase courte",
  "moyen": "le moyen concret proposé, une phrase courte",
  "domaine": "un des mots EXACTS suivants, rien d'autre: environnement, transport, energie, sante, education, economie, technologie, international, social, autre"
}
Utilise "questionne" quand la phrase pose une question sur un sujet sans
prendre position ("Comment financer cette transition ?") — ce n'est ni un
accord ni un désaccord, et ça doit rester distinguable des deux.
Ne produis rien d'autre que ce JSON.`;

// Ces deux listes DOIVENT rester synchronisées avec celles de
// scripts/validate-submission.mjs (source de vérité côté serveur). Un
// petit modèle local comme Llama-3.2-1B-Instruct ne respecte pas toujours
// une consigne d'enum fermé à la lettre — il peut renvoyer une phrase
// libre ("la consommation de bonbons gratuits") au lieu d'une des valeurs
// attendues. Plutôt que de laisser une valeur invalide voyager jusqu'à
// l'Issue GitHub pour se faire rejeter côté serveur — un aller-retour
// complet pour rien — on la corrige ici, tout de suite, avant même
// d'afficher un résultat à l'utilisateur.
const ALLOWED_DOMAINS = new Set([
  "environnement", "transport", "energie", "sante", "education",
  "economie", "technologie", "international", "social", "autre",
]);
const ALLOWED_RELATION_TYPES = new Set([
  "implique", "contredit", "complete", "generalise", "specialise",
  "alternative_a", "depend_de", "questionne",
]);

function normalizeEnum(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");
}

// parseWithAI(text) -> { concepts, relations, objective, means, domain }
export async function parseWithAI(text) {
  const e = await loadModel();
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
  if (!jsonMatch) throw new Error("Le modèle n'a pas produit de JSON exploitable.");
  const parsed = JSON.parse(jsonMatch[0]);

  const domainCandidate = normalizeEnum(parsed.domaine);
  const domain = ALLOWED_DOMAINS.has(domainCandidate) ? domainCandidate : "autre";

  const relations = (parsed.relations || [])
    .map((r) => ({
      type: normalizeEnum(r?.type),
      target_hint: r?.target_hint || "",
    }))
    // Une relation dont le type est hors-liste est abandonnée plutôt que
    // requalifiée au hasard : le modèle n'a produit qu'un type sur les 7
    // permis, on ne peut pas deviner lequel il voulait dire.
    .filter((r) => ALLOWED_RELATION_TYPES.has(r.type) && r.target_hint);

  return {
    concepts: parsed.concepts || [],
    relations,
    objective: parsed.objectif || "",
    means: parsed.moyen || "",
    domain,
  };
}

// ---- Deterministic canonicalization (mirrors scripts/canonical.mjs) ----
// Kept in sync manually. If you change one, change the other, or the CI's
// re-verification of canonical_key will reject every legitimate submission.

function stripDiacritics(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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
