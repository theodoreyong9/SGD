// Semantic layer: text -> structured representation, pour l'APERÇU
// LOCAL uniquement.
//
// CHANGEMENT IMPORTANT : ce fichier ne détermine plus l'identité d'une
// soumission. L'extraction sémantique qui fait autorité tourne désormais
// côté serveur (scripts/semantic-extract.mjs, sur le seul `text` soumis),
// pour empêcher qu'un client construise un bloc `semantic` sans rapport
// réel avec son texte tout en restant interne-cohérent. `parseWithAI` et
// `canonicalKey` ci-dessous ne servent donc plus qu'à afficher un aperçu
// avant publication (concepts, domaine, proposition la plus proche dans
// le graphe) — jamais transmis au serveur, jamais garanti de correspondre
// à ce que le serveur produira pour le même texte.

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

// Répare les erreurs de JSON les plus fréquentes chez un petit modèle
// local (virgule finale avant `]` ou `}`) — bien plus fréquent que du JSON
// franchement aléatoire. Ne corrige pas tout, juste ce cas précis, qui
// suffit à éviter la majorité des plantages observés en pratique.
function repairTrailingCommas(jsonText) {
  return jsonText.replace(/,\s*([\]}])/g, "$1");
}

// Repli minimal si le modèle local ne produit vraiment rien d'exploitable
// — mirroir volontaire de minimalFallback() dans
// scripts/semantic-extract.mjs, pour la même raison : ceci n'est qu'un
// APERÇU (voir en-tête de fichier), donc un échec de génération ne doit
// jamais bloquer l'utilisateur, juste dégrader l'aperçu affiché.
function minimalFallback(text) {
  const words = String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 3);
  return {
    concepts: words.length > 0 ? words : ["proposition"],
    relations: [],
    objective: "",
    means: "",
    domain: "autre",
  };
}

// parseWithAI(text) -> { concepts, relations, objective, means, domain }
//
// Ne lève jamais pour un JSON malformé ou absent : retombe sur un aperçu
// minimal plutôt que de casser tout le flux de soumission. C'est un
// aperçu (voir en-tête de fichier) — un aléa de génération locale ne doit
// jamais empêcher l'utilisateur d'aller jusqu'à la publication, où seule
// l'extraction serveur compte réellement.
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
  if (!jsonMatch) {
    console.warn("parseWithAI: aucun JSON exploitable dans la sortie du modèle, repli minimal.");
    return minimalFallback(text);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    try {
      parsed = JSON.parse(repairTrailingCommas(jsonMatch[0]));
    } catch (e2) {
      console.warn("parseWithAI: JSON invalide même après réparation, repli minimal —", e2.message);
      return minimalFallback(text);
    }
  }

  const domainCandidate = normalizeEnum(parsed.domaine);
  const domain = ALLOWED_DOMAINS.has(domainCandidate) ? domainCandidate : "autre";

  const relations = (Array.isArray(parsed.relations) ? parsed.relations : [])
    .map((r) => ({
      type: normalizeEnum(r?.type),
      target_hint: r?.target_hint || "",
    }))
    // Une relation dont le type est hors-liste est abandonnée plutôt que
    // requalifiée au hasard : le modèle n'a produit qu'un type sur les 8
    // permis, on ne peut pas deviner lequel il voulait dire.
    .filter((r) => ALLOWED_RELATION_TYPES.has(r.type) && r.target_hint);

  const concepts = Array.isArray(parsed.concepts) ? parsed.concepts : [];
  if (concepts.length === 0) return minimalFallback(text);

  return {
    concepts,
    relations,
    objective: parsed.objectif || "",
    means: parsed.moyen || "",
    domain,
  };
}

// ---- Canonicalisation locale (miroir de scripts/canonical.mjs) ----
// AVERTISSEMENT : contrairement à ce que ce commentaire disait avant le
// passage à l'extraction serveur, la CI ne recalcule PLUS et ne compare
// PLUS jamais ce que cette fonction produit — voir l'en-tête de fichier.
// `canonicalKey` reste ici uniquement comme utilitaire potentiellement
// utile (ex: dédupliquer localement plusieurs aperçus dans une session),
// mais rien dans l'app ne l'utilise plus pour décider quoi que ce soit
// côté identité. Gardée synchronisée avec scripts/canonical.mjs par
// habitude, pas par nécessité protocolaire.

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
