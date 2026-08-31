# Semantic Graph Democracy — squelette

Implémentation de référence du procédé décrit dans le document de projet :
une seule opération de soumission = recherche + navigation + participation
au graphe collectif, sans bouton pour/contre.

## Architecture

```
Navigateur (GitHub Pages, statique)
  ├─ WebLLM (src/semantic.js)          — parsing sémantique local, dans le navigateur
  ├─ Canonicalisation (src/semantic.js) — déterministe, miroir de scripts/canonical.mjs
  └─ Lien de soumission (src/publish.js) — Issue GitHub pré-remplie, aucun compte tiers

GitHub Actions (un seul workflow, déclenché par les Issues)
  └─ process-submission.yml (issues: opened)
       → extrait le bloc JSON du corps de l'issue (donnée, jamais du code exécuté)
       → RECALCULE canonical_key à partir de zéro, ne fait jamais confiance à l'issue
       → si valide : met à jour data/graph.json, commit + push sur main, ferme l'issue
       → si invalide : commente les raisons, ferme l'issue sans rien modifier
```

Il n'y a plus ni relais CORS, ni OAuth App, ni fork/PR. Voir "Pourquoi ce
choix" ci-dessous pour ce que ça change par rapport à la version précédente.

## Pourquoi une Issue GitHub plutôt qu'un fork + PR authentifié

La version précédente utilisait le Device Flow OAuth de GitHub pour obtenir
un token, forkait le dépôt, poussait un commit sur une branche, et ouvrait
une PR par l'API — tout depuis le navigateur. Ça marchait, mais ça exigeait
de créer une GitHub OAuth App et de déployer un relais CORS (les endpoints
`github.com/login/device/code` et `github.com/login/oauth/access_token` ne
renvoient pas d'en-têtes CORS), donc un composant serveur de plus à
maintenir, même sans secret.

`github.com/OWNER/REPO/issues/new?title=...&body=...` est un **lien**, pas
un appel `fetch()`. Une navigation classique n'est jamais soumise à CORS —
CORS ne s'applique qu'aux requêtes JavaScript cross-origin. Le flux devient :

1. L'utilisateur écrit sa proposition → WebLLM l'analyse localement, comme avant.
2. Le site construit un lien vers une nouvelle Issue, avec le JSON structuré
   déjà rempli dans le corps (`src/publish.js`).
3. L'utilisateur clique → arrive sur `github.com`, déjà connecté à **son
   propre compte**, jamais au nôtre → relit → clique "Submit new issue".
4. `process-submission.yml`, déclenché par `issues: opened`, lit le corps,
   revalide tout exactement comme avant (recalcul de `canonical_key`, jamais
   fait confiance à ce que contient l'issue), et met à jour le graphe.

Zéro compte à créer côté app, zéro token dans le navigateur, zéro CORS, zéro
composant serveur à déployer en dehors de GitHub lui-même. Le seul coût :
un clic de confirmation supplémentaire sur `github.com` — ce qui est plutôt
une bonne chose côté anti-spam (confirmation humaine native sur un domaine
qu'aucune page tierce ne peut simuler par script), pas seulement une
contrainte technique.

## Mise en place

1. **Configurer le dépôt cible** dans `src/publish.js` : `OWNER`, `REPO`.
2. **Activer GitHub Pages** sur ce dépôt (Settings → Pages → Source: GitHub
   Actions). Le workflow `deploy.yml` s'en charge à chaque push sur `main`.
3. **Permissions Actions** : Settings → Actions → General → Workflow
   permissions → "Read and write permissions", pour que
   `process-submission.yml` puisse committer et pousser sur `main`.
4. Rien d'autre. Pas d'OAuth App, pas de relais à déployer, pas de secret à
   configurer au-delà du `GITHUB_TOKEN` fourni automatiquement par Actions.

## Modèle de sécurité — ce qui est garanti et ce qui ne l'est pas

**Garanti par construction :**
- Le corps d'une Issue est traité comme de la **donnée**, jamais comme du
  **code** : `process-submission.yml` ne fait que le lire via
  `actions/github-script` (jamais interpolé dans une chaîne shell — c'est
  le vecteur d'injection classique de `${{ github.event.issue.body }}` dans
  un bloc `run:`) puis le passer à `validate-submission.mjs`, qui ne fait
  que `JSON.parse` + vérification de schéma.
- `canonical_key` n'est jamais fait confiance venant du client : recalculé
  côté CI à partir du contenu structuré, de façon déterministe. N'importe
  qui peut modifier le bloc JSON pré-rempli avant de cliquer "Submit" — le
  protocole n'a jamais dépendu de ça pour son intégrité.
- Aucun code d'un tiers n'est jamais exécuté par la CI (pas d'équivalent
  `pull_request_target` checkoutant du code externe — il n'y a plus de PR
  du tout dans ce flux).
- La répétition d'une même proposition canonique a un rendement marginal
  décroissant (`1/n`), implémenté dans `scripts/process-graph.mjs`.

**Non garanti, par limite structurelle :**
- **Origine de la requête.** Rien n'empêche quelqu'un de forger une Issue
  identique via l'API GitHub avec son propre token, en dehors de l'interface.
  Ce n'est pas un problème dans ce design : le pipeline de validation évalue
  le contenu, pas la provenance — résistance Sybil sans dépendre de "qui"
  soumet.
- **Unicité humaine.** Un compte GitHub a un coût pour être créé en masse,
  mais ce n'est pas une preuve d'humanité. Si vous avez besoin de cette
  garantie, il faut un mécanisme externe.
- **Résistance Sybil face à la reformulation.** Le rendement décroissant
  s'applique par proposition **canonique** : un attaquant patient qui
  reformule légèrement à chaque envoi (assez pour changer `canonical_key`,
  pas assez pour changer le sens) contourne partiellement la décroissance.
  On pourrait durcir ça en pénalisant un auteur dont les soumissions
  récentes sont mutuellement très proches en embedding — mais ça exigerait
  de stocker une identité de contributeur par nœud, ce que ce design évite
  délibérément (le score d'un nœud ne dépend jamais de qui l'a écrit).
  Laissé en l'état, en connaissance de cause.
- **Qualité de l'extraction sémantique.** Le modèle utilisé
  (`Llama-3.2-1B-Instruct`) est volontairement petit pour tourner sur des
  machines modestes ; un modèle plus gros donnera une meilleure structuration
  au prix d'un téléchargement et d'un temps d'inférence plus longs.
- **Le rate-limiting par compte est un disjoncteur, pas une preuve
  d'humanité.** Il protège contre un seul compte qui inonde la file plus
  vite que le rendement décroissant ne peut absorber, pas contre la
  création massive de comptes.

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
  après traitement) fait autorité : cet aperçu n'est jamais une garantie,
  juste une UX.
- **Score de pont sémantique** (`bridge`) : combine désormais la diversité
  des domaines *déclarés* voisins (signal d'origine) **et** la dispersion
  des *embeddings* de ces mêmes voisins entre eux, à parts égales. Un nœud
  dont les voisins sont sémantiquement dispersés relie réellement des idées
  qui ne se touchaient pas autrement — indépendamment de l'étiquette de
  domaine choisie par le LLM à la soumission, qui reste un enum fermé de 10
  valeurs et ne devrait donc pas porter tout le poids du score.
- **Stabilité par engagement, pas seulement par âge** (`stability`) : la
  persistance temporelle (âge/30 jours) plafonne désormais à 0.4 si la
  proposition n'a jamais été reprise, reliée ou contestée depuis sa première
  apparition. Le reste du score dépend de deux signaux structurels sans
  identité de contributeur : réapparitions au-delà de la première, et
  nombre d'arêtes accumulées.
- **Décomposition de l'influence visible** : chaque nœud expose
  `stats.breakdown = {novelty, contribution, bridge, stability, influence}`,
  affiché sous forme de barres dans l'interface.
- **Synthèse par IA d'un sous-graphe** : bouton "Synthétiser" qui invoque le
  modèle WebLLM déjà chargé sur l'ensemble des propositions d'un domaine —
  vue dérivée générée à la demande, jamais stockée comme donnée de référence.
- **Navigation à deux niveaux (paysage / région)** : cliquer un nœud dans le
  graphe estompe tout ce qui n'appartient pas à son domaine (`src/graph-render.js`,
  `setFocusDomain`) ; un bouton "Voir tout le graphe" réinitialise. C'est un
  filtre visuel sur le graphe existant, pas un vrai niveau "sujet =
  sous-graphe recalculé" — voir Limites connues.
- **Publication sans compte tiers, sans OAuth, sans relais** (`src/publish.js`,
  `.github/workflows/process-submission.yml`) : Issue GitHub pré-remplie,
  revalidée entièrement côté serveur.
- **Rate-limiting par compte GitHub** (30 soumissions/24h par défaut,
  ajustable dans `scripts/validate-submission.mjs`), vérifié via l'API
  Search de GitHub filtrée sur le label `sgd-submission`, appliqué même aux
  issues invalides pour éviter le spam gratuit par JSON malformé.

## Limites connues

- **`domaine` reste un enum fermé, pas un espace émergent.** Le score
  `bridge` en dépend encore partiellement (voir plus haut) ; une vraie
  suite consisterait à clusteriser les embeddings eux-mêmes plutôt que de
  faire choisir une catégorie fixe par le LLM à chaque soumission.
- **Pas de vrai niveau "sujet".** La doctrine du projet distingue trois
  niveaux (paysage / région / sujet), où un "sujet" est un sous-graphe
  *recalculé*, pas un filtre. Ce squelette n'implémente que les deux
  premiers.
- **Résistance Sybil à la reformulation** : voir "Modèle de sécurité" plus haut.
- Une vraie preuve d'unicité humaine si le protocole doit un jour en
  dépendre (aujourd'hui volontairement absente).
- Pagination/limite d'affichage du graphe côté client au-delà de quelques
  milliers de nœuds (le rendu `canvas` en `graph-render.js` est O(n²) sur
  les répulsions, à remplacer par un quadtree si le graphe grossit
  significativement).
- Un vrai stockage des embeddings en format binaire compact plutôt qu'un
  tableau JSON de 384 flottants par nœud si `data/graph.json` devient
  volumineux.
