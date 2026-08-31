# Semantic Graph Democracy — squelette

Implémentation de référence du procédé décrit dans le document de projet :
une seule opération de soumission = recherche + navigation + participation
au graphe collectif, sans bouton pour/contre.

## Architecture

```
Navigateur (GitHub Pages, statique)
  ├─ WebLLM (src/semantic.js)      — parsing sémantique local, dans le navigateur
  ├─ Canonicalisation (src/semantic.js) — déterministe, miroir de scripts/canonical.mjs
  ├─ OAuth Device Flow (src/oauth.js)   — via un relais CORS sans état
  └─ Fork + PR (src/github-api.js)      — publication directe via l'API GitHub

Relais CORS (proxy/worker.js, Cloudflare Worker gratuit)
  └─ Ne fait que transmettre 2 endpoints que GitHub bloque en cross-origin.
     Aucun secret stocké. Voir "Pourquoi ce relais existe" ci-dessous.

GitHub Actions
  ├─ validate-submission.yml (pull_request, non privilégié)
  │    → vérifie le diff, le schéma, RECALCULE canonical_key
  │    → produit un verdict, ne fusionne jamais rien
  └─ process-merge.yml (workflow_run, privilégié)
       → lit le verdict, fusionne si valide, régénère data/graph.json
```

## Pourquoi ce relais existe

Le Device Flow OAuth de GitHub est conçu pour ne pas nécessiter de secret
client, mais les endpoints `github.com/login/device/code` et
`github.com/login/oauth/access_token` ne renvoient pas d'en-têtes CORS —
contrairement à `api.github.com`. Un appel `fetch()` direct depuis le
navigateur échoue donc, indépendamment de toute configuration côté client.
`proxy/worker.js` ne fait que relayer ces deux appels avec les bons en-têtes ;
il ne détient et ne voit passer aucun secret (le `client_id` d'une app OAuth
est public par nature).

Si vous voulez éviter complètement ce composant, la seule alternative est de
redemander à l'utilisateur un Personal Access Token collé manuellement — ce
qui réintroduit exactement les risques de phishing/exfiltration détaillés
dans la conversation qui a précédé ce squelette. Le relais est le compromis
le plus proche du "100% statique" sans les recréer.

## Mise en place

1. **Créer une GitHub OAuth App** (Settings → Developer settings → OAuth Apps).
   Activer *Device Flow*. Noter le `Client ID` (pas besoin de secret).
2. **Déployer le relais** : `cd proxy && wrangler deploy`. Récupérer l'URL
   `*.workers.dev`.
3. **Configurer les constantes** :
   - `src/oauth.js` : `PROXY_BASE`, `CLIENT_ID`
   - `src/github-api.js` : `UPSTREAM_OWNER`, `UPSTREAM_REPO`
4. **Activer GitHub Pages** sur ce dépôt (Settings → Pages → Source: GitHub
   Actions). Le workflow `deploy.yml` s'en charge à chaque push sur `main`.
5. **Permissions Actions** : Settings → Actions → General → Workflow
   permissions → "Read and write permissions", pour que
   `process-merge.yml` puisse fusionner les PR et pousser sur `main`.
6. **Branch protection sur `main`** : si vous en activez une, autorisez le
   bot (`github-actions[bot]`) à contourner la revue obligatoire, sinon
   `process-merge.yml` ne pourra pas fusionner automatiquement.

## Modèle de sécurité — ce qui est garanti et ce qui ne l'est pas

**Garanti par construction :**
- Une PR de soumission ne peut modifier qu'un seul fichier, sous
  `submissions/pending/`, en ajout uniquement (`validate-submission.mjs`,
  vérifié à partir de la version de `main`, jamais celle de la PR elle-même
  — sinon un attaquant pourrait modifier le validateur en même temps que sa
  soumission).
- `canonical_key` n'est jamais fait confiance venant du client : il est
  recalculé côté CI à partir du contenu structuré, de façon déterministe
  (section 8 du document de spec).
- Aucun workflow n'exécute de code de PR avec des secrets
  (`pull_request_target` n'est utilisé nulle part).
- La répétition d'une même proposition canonique a un rendement marginal
  décroissant (`1/n`), implémenté dans `scripts/process-graph.mjs`.

**Non garanti, par limite structurelle :**
- **Origine de la requête.** Rien n'empêche quelqu'un de forger un appel API
  identique à celui que fait l'interface, avec son propre token. Ce n'est
  pas un problème dans ce design : le pipeline de validation évalue le
  contenu, pas la provenance (voir section 31 du document — résistance
  Sybil sans dépendre de "qui" soumet).
- **Unicité humaine.** Un compte GitHub a un coût pour être créé en masse,
  mais ce n'est pas une preuve d'humanité. Si vous avez besoin de cette
  garantie, il faut un mécanisme externe (voir section 32 du document).
- **Qualité de l'extraction sémantique.** Le modèle utilisé
  (`Llama-3.2-1B-Instruct`) est volontairement petit pour tourner sur des
  machines modestes ; un modèle plus gros donnera une meilleure structuration
  au prix d'un téléchargement et d'un temps d'inférence plus longs.
- **Le rate-limiting par compte est un disjoncteur, pas une preuve
  d'humanité.** Il protège contre un seul compte qui inonde la file plus
  vite que le rendement décroissant ne peut absorber, pas contre la
  création massive de comptes (voir section 32).

## Fonctionnalités implémentées

- **Canonicalisation déterministe** (`scripts/canonical.mjs`), re-vérifiée
  côté CI, jamais fait confiance au client.
- **Rendement marginal décroissant** (`1/n`) sur les soumissions répétées
  d'une même proposition canonique.
- **Embeddings sémantiques réels** (`all-MiniLM-L6-v2` via transformers.js,
  CPU/WASM) pour la nouveauté et le matching de relations — remplace le
  recouvrement de mots-clés. Deux paraphrases lexicalement très différentes
  du même contenu sont maintenant reconnues comme proches. Le modèle tourne
  aussi côté client (`src/embeddings.js`, WASM) pour l'aperçu avant
  publication, mais seule la version serveur (`scripts/embeddings.mjs`,
  après merge) fait autorité — cohérent avec la séparation IA/protocole de
  la section 35 : cet aperçu n'est jamais une garantie, juste une UX.
- **Score de pont entre domaines** (`bridge`, approximation de la section 21)
  et **stabilité temporelle** (`stability`, section 29), tous deux stockés
  et recalculés à chaque mise à jour du graphe.
- **Décomposition de l'influence visible** (section 37) : chaque nœud
  expose `stats.breakdown = {novelty, contribution, bridge, stability,
  influence}`, affiché sous forme de barres dans l'interface.
- **Synthèse par IA d'un sous-graphe** (section 25) : bouton "Synthétiser"
  qui invoque le modèle WebLLM déjà chargé sur l'ensemble des propositions
  d'un domaine — vue dérivée générée à la demande, jamais stockée comme
  donnée de référence.
- **Rate-limiting par compte GitHub** (30 PR/24h par défaut, ajustable dans
  `scripts/validate-submission.mjs`), vérifié via l'API Search de GitHub
  avec le token en lecture seule du workflow non privilégié.

## Ce qui reste à construire pour une vraie mise en production

- Une vraie preuve d'unicité humaine si le protocole doit un jour en
  dépendre (aujourd'hui volontairement absent, voir section 32).
- Pagination/limite d'affichage du graphe côté client au-delà de quelques
  milliers de nœuds (le rendu `canvas` en `graph-render.js` est O(n²) sur
  les répulsions, à remplacer par un quadtree si le graphe grossit
  significativement).
- Un vrai stockage des embeddings en format binaire compact plutôt qu'un
  tableau JSON de 384 flottants par nœud si `data/graph.json` devient
  volumineux.
