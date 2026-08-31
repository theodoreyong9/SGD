// Extraction sémantique côté SERVEUR — nouvelle source de vérité pour
// canonical_key.
//
// LE PROBLÈME QUE ÇA RÉSOUT : jusqu'ici, seul le navigateur de la personne
// qui soumet exécutait l'extraction WebLLM (src/semantic.js), et le
// serveur se contentait de revérifier que canonical_key correspondait bien
// au bloc `semantic` déclaré par ce même navigateur. Ça protège contre un
// hash falsifié isolément, mais pas contre un bloc `semantic` construit à
// la main, sans rapport réel avec `text`, tout en restant interne-cohérent
// avec lui-même — la personne qui soumet est justement celle dont on
// voulait garantir la neutralité de l'extraction. Le validateur ne peut
// rien détecter dans ce cas : structurellement, c'est un JSON parfaitement
// valide.
//
// Cette version élimine le problème à la racine plutôt que de le détecter
// après coup : scripts/validate-submission.mjs ne lit plus QUE `text` —
// tout bloc `semantic` ou `canonical_key` que le client aurait pu inclure
// est désormais purement et simplement ignoré. C'est CE fichier qui
// produit la structure faisant autorité, à partir du seul texte brut (une
// chaîne de caractères, pas une structure qu'on peut falsifier en gardant
// une cohérence interne).
//
// COÛT : les runners GitHub Actions sont gratuits et illimités sur dépôt
// public (comme pour scripts/embeddings.mjs) — pas de facture cachée. Le
// vrai coût est la latence : une génération CPU, même sur un petit modèle,
// prend potentiellement plusieurs dizaines de secondes. Comme le
// traitement d'une Issue est déjà asynchrone, ce n'est pas bloquant pour
// qui que ce soit.
//
// Le WebLLM côté client (src/semantic.js) reste utilisé pour l'APERÇU
// instantané avant publication — même séparation IA/protocole que pour
// les embeddings : l'aperçu client n'est jamais une garantie, seule cette
// extraction serveur fait autorité.
//
// LIMITE HONNÊTE : le choix de modèle ci-dessous (MODEL_ID) n'a pas pu
// être validé en conditions réelles au moment où ce fichier a été écrit —
// transformers.js et la disponibilité de modèles ONNX compatibles avec
// une pipeline text-generation + chat template évoluent vite. Si
// l'extraction échoue systématiquement en production, commencez par
// vérifier ce nom de modèle avant de suspecter le reste du pipeline.

import { pipeline, env } from "@xenova/transformers";

env.cacheDir = ".cache/transformers";

// Modèle d'instruction compact, connu pour fonctionner avec la pipeline
// text-generation + messages de transformers.js (chat template intégré).
// Alternative à essayer si celui-ci pose problème en CI :
// "Xenova/Qwen1.5-0.5B-Chat" (plus petit, potentiellement moins précis).
const MODEL_ID = "Xenova/TinyLlama-1.1B-Chat-v1.0";

let generatorPromise = null;
function getGenerator() {
  if (!generatorPromise) generatorPromise = pipeline("text-generation", MODEL_ID);
  return generatorPromise;
}

// Copie du prompt de src/semantic.js — les deux DOIVENT rester
// synchronisés. Une divergence n'affecte jamais l'identité (seul CE
// fichier fait autorité pour canonical_key), seulement la cohérence entre
// l'aperçu client et le résultat final — gênant pour l'UX, pas pour la
// sécurité du protocole.
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

// extractSemantic(text) -> { concepts, relations, objective, means, domain }
//
// Ne lève jamais pour un JSON malformé, un enum hors-liste, ou un échec de
// génération : retombe sur une extraction minimale plutôt que de faire
// échouer tout le traitement d'une soumission à cause d'un aléa de
// génération. Une extraction pauvre donne simplement un nœud peu
// informatif (peu de concepts, domaine "autre", novelty probablement
// élevée faute de correspondance) — c'est un comportement dégradé
// acceptable, pas un blocage du pipeline.
export async function extractSemantic(text) {
  const generator = await getGenerator();

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: text },
  ];

  let raw = "";
  try {
    const output = await generator(messages, {
      max_new_tokens: 300,
      do_sample: false,
      temperature: 0,
    });
    raw = output?.[0]?.generated_text;
    // Selon la version de transformers.js, generated_text peut être une
    // simple chaîne ou le tableau complet des messages (système + user +
    // assistant) — dans ce dernier cas, seul le dernier tour nous intéresse.
    if (Array.isArray(raw)) raw = raw[raw.length - 1]?.content || "";
  } catch (err) {
    console.warn("extractSemantic: échec de génération, repli minimal —", err.message);
    return minimalFallback(text);
  }

  const jsonMatch = String(raw || "").match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn("extractSemantic: aucun JSON exploitable dans la sortie, repli minimal.");
    return minimalFallback(text);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    console.warn("extractSemantic: JSON invalide, repli minimal.");
    return minimalFallback(text);
  }

  const domainCandidate = normalizeEnum(parsed.domaine);
  const domain = ALLOWED_DOMAINS.has(domainCandidate) ? domainCandidate : "autre";

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
    objective: String(parsed.objectif || "").slice(0, 300),
    means: String(parsed.moyen || "").slice(0, 300),
    domain,
  };
}

// Repli minimal : quelques mots significatifs extraits mécaniquement du
// texte brut, sans IA. Garantit que le pipeline avance toujours, au prix
// d'un nœud peu informatif — préférable à un blocage total.
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
