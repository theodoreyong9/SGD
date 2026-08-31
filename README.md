# Semantic Graph Democracy — squelette

Implémentation de référence du procédé décrit dans le document de projet :
une seule opération de soumission = recherche + navigation + participation
au graphe collectif, sans bouton pour/contre.

## Architecture

```
Navigateur (GitHub Pages, statique)
  ├─ WebLLM (src/semantic.js)          — parsing sémantique local, APERÇU UNIQUEMENT
  ├─ Publication — DEUX chemins possibles, choisis automatiquement :
  │    (a) OAuth configuré + connecté → src/github-api.js crée l'Issue en
  │        DIRECT via l'API, aucune redirection vers github.com
  │    (b) sinon → src/publish.js construit un lien d'Issue pré-remplie
  │        (repli historique, fonctionne sans aucune configuration)
  └─ Recherche pure (bouton "Rechercher") — embedding direct du texte, sans WebLLM,
       consulte le graphe sans jamais préparer de soumission

GitHub Actions (deux workflows)
  ├─ process-submission.yml (issues: opened)
  │    → extrait `text` du corps de l'issue (donnée, jamais du code exécuté) —
  │      tout le reste du bloc JSON (semantic, canonical_key) est ignoré, même
  │      si un client en envoie encore
  │    → scripts/semantic-extract.mjs : extraction sémantique SERVEUR à partir
  │      de `text` seul — c'est CETTE structure, jamais celle d'un client, qui
  │      détermine canonical_key
  │    → si valide : met à jour data/graph.json, commit + push sur main, ferme l'issue
  │    → si invalide : commente les raisons, ferme l'issue sans rien modifier
  └─ deploy.yml (push sur main OU fin de process-submission.yml)
       → republie le site sur GitHub Pages — voir "Pourquoi deux déclencheurs" ci-dessous
```

Il n'y a plus ni relais CORS, ni OAuth App, ni fork/PR. Voir "Pourquoi ce
choix" ci-dessous pour ce que ça change par rapport à la version précédente.

## Pourquoi l'extraction sémantique tourne maintenant côté serveur

Jusqu'ici, seul le navigateur de la personne qui soumet exécutait
l'extraction WebLLM, et le serveur se contentait de revérifier que
`canonical_key` correspondait bien au bloc `semantic` déclaré par ce même
navigateur. Ça protège contre un hash falsifié isolément, mais pas contre
un bloc `semantic` construit à la main, sans rapport réel avec `text`, tout
en restant interne-cohérent avec lui-même — la personne qui soumet est
justement celle dont on voulait garantir la neutralité de l'extraction.
Aucune vérification de hash ne peut détecter ce cas : structurellement,
c'est un JSON parfaitement valide.

`scripts/semantic-extract.mjs` élimine le problème à la racine plutôt que
de le détecter après coup : `scripts/validate-submission.mjs` ne lit plus
QUE `text` — tout bloc `semantic` ou `canonical_key` qu'un client
enverrait encore est purement et simplement ignoré, jamais transmis à la
suite du pipeline. C'est le serveur qui extrait sa propre structure, sur
un modèle qui tourne dans le runner GitHub Actions — gratuit et illimité
sur dépôt public, comme pour les embeddings. Le WebLLM côté client
(`src/semantic.js`) reste utilisé pour l'aperçu instantané avant
publication, mais n'a plus aucun rôle protocolaire : rien de ce qu'il
produit n'est envoyé au serveur.

Coût réel de ce changement : la latence. Une génération CPU, même sur un
petit modèle, prend potentiellement plusieurs dizaines de secondes — pas
un problème puisque le traitement d'une Issue est déjà asynchrone.

## Pourquoi `deploy.yml` a deux déclencheurs

`process-submission.yml` pousse son commit avec le `GITHUB_TOKEN`
automatique de l'Actions runner. GitHub bloque **volontairement** le
déclenchement en chaîne d'un autre workflow sur l'événement `push` que ce
token produit — protection anti-boucle infinie intégrée à Actions,
documentée mais facile à oublier. Sans le second déclencheur
(`workflow_run`, qui écoute la fin de `process-submission.yml` plutôt que
l'événement push lui-même), le graphe se met à jour dans le dépôt mais le
site continue de servir une version périmée indéfiniment, jusqu'à ce que
quelqu'un pousse manuellement autre chose sur `main`. C'est exactement le
symptôme qui s'est produit avant l'ajout de ce trigger.

## Publication : deux chemins, choisis automatiquement

La toute première version de ce projet utilisait un flux OAuth complet
(Device Flow + relais + appels API) pour publier directement, sans jamais
ouvrir GitHub. On l'a ensuite simplifié en un simple lien pré-rempli — plus
robuste, zéro configuration, mais avec un vrai défaut : chaque soumission
redirige vers `github.com` et exige un clic manuel sur "Submit new issue"
là-bas. Cette version restaure la publication directe **en plus** du lien,
sans sacrifier la robustesse : si l'OAuth n'est pas configuré, le site
continue de fonctionner exactement comme avant.

### Ce qui a rendu ça possible

`api.github.com` supporte CORS nativement pour les requêtes authentifiées
(`Access-Control-Allow-Origin: *`, vérifié directement) — un `fetch()`
depuis le navigateur vers l'API GitHub fonctionne donc sans aucun relais,
**une fois qu'on a un token**. Le seul obstacle restant : les deux
endpoints d'échange OAuth Device Flow
(`github.com/login/device/code`, `github.com/login/oauth/access_token`)
n'ont pas de CORS (vérifié : ils répondent `404` à une requête `OPTIONS`,
contrairement à `api.github.com` qui répond `204` avec les en-têtes CORS).
Il faut donc un relais — mais seulement pour ces deux appels précis, et
**sans aucun secret à protéger** : le Device Flow, contrairement au flow
"Authorization Code" classique des boutons "Login with GitHub", ne
nécessite pas de `client_secret`. `proxy/worker.js` ne fait donc que
transmettre deux requêtes en ajoutant des en-têtes CORS — il ne détient
rien de sensible.

### Le flux, en pratique

1. **Sans configuration** (`src/config.js` avec les valeurs par défaut) :
   comportement identique à avant — lien pré-rempli, redirection vers
   GitHub, clic manuel sur "Submit new issue".
2. **Avec OAuth configuré**, première publication : l'utilisateur clique
   "Se connecter et publier" → une popup GitHub s'ouvre avec un code à 8
   caractères pré-rempli → un clic sur "Authorize" là-bas suffit → le token
   est stocké dans `localStorage` de ce navigateur.
3. **Toute publication suivante**, dans ce même navigateur : `fetch()`
   direct vers `api.github.com/repos/OWNER/REPO/issues`, invisible, sans
   jamais ouvrir GitHub. Coût réel : le clic d'autorisation initial reste
   nécessaire (impossible d'établir une confiance sans qu'un humain
   confirme une fois sur `github.com`), mais il n'est plus jamais répété.

### Mise en place du flux direct (optionnel)

Le site fonctionne sans rien de ce qui suit — ces étapes ne sont
nécessaires que si vous voulez la publication invisible plutôt que le lien.

1. **Créer une OAuth App GitHub** : Settings → Developer settings → OAuth
   Apps → New OAuth App. Homepage URL : l'URL de votre GitHub Pages
   (`https://theodoreyong9.github.io/SGD`). Authorization callback URL :
   requise par le formulaire mais non utilisée par le Device Flow — mettez
   la même URL. Une fois créée, ouvrez les réglages de l'app et cochez
   **"Enable Device Flow"**.
2. **Récupérer le Client ID** (visible sur la page de l'app — c'est une
   donnée publique, pas le secret) et le coller dans
   `src/config.js` (`OAUTH_CLIENT_ID`). Ne jamais générer ni utiliser de
   client secret : le Device Flow n'en a pas besoin.
3. **Déployer `proxy/worker.js`** sur Cloudflare Workers (offre gratuite
   suffisante) :
   ```
   cd proxy
   npx wrangler deploy
   ```
   Copiez l'URL `*.workers.dev` obtenue dans `src/config.js` (`PROXY_URL`).
4. Rechargez le site : dès que `OAUTH_CLIENT_ID` et `PROXY_URL` ne sont
   plus les valeurs par défaut, la pastille de connexion apparaît et le
   bouton "Publier" bascule automatiquement en mode direct.

## Mise en place minimale (obligatoire, quel que soit le mode de publication)

1. **Configurer le dépôt cible** dans `src/config.js` : `OWNER`, `REPO`
   (déjà réglé sur `theodoreyong9`/`SGD` dans cette livraison).
2. **Activer GitHub Pages** sur ce dépôt (Settings → Pages → Source: GitHub
   Actions). Le workflow `deploy.yml` s'en charge à chaque push sur `main`.
3. **Permissions Actions** : Settings → Actions → General → Workflow
   permissions → "Read and write permissions", pour que
   `process-submission.yml` puisse committer et pousser sur `main`.
4. Rien d'autre n'est requis pour que le site fonctionne — la publication
   se fera via le lien pré-rempli (voir ci-dessus) tant que l'OAuth
   optionnel n'est pas configuré.

## Modèle de sécurité — ce qui est garanti et ce qui ne l'est pas

**Garanti par construction :**
- Le corps d'une Issue est traité comme de la **donnée**, jamais comme du
  **code** : `process-submission.yml` ne fait que le lire via
  `actions/github-script` (jamais interpolé dans une chaîne shell — c'est
  le vecteur d'injection classique de `${{ github.event.issue.body }}` dans
  un bloc `run:`) puis le passer à `validate-submission.mjs`, qui ne fait
  que `JSON.parse` + vérification de schéma sur `text` seul.
- **`semantic` et `canonical_key` ne sont plus des champs que le client
  peut influencer.** Ce n'est plus seulement "revérifié" : ces champs ne
  sont même plus lus depuis l'issue. Le serveur extrait sa propre
  structure à partir de `text` seul (`scripts/semantic-extract.mjs`) et en
  dérive lui-même `canonical_key`. Un bloc `semantic` fabriqué à la main,
  sans rapport avec `text` mais interne-cohérent — la faille qu'une
  simple revérification de hash ne pouvait pas fermer — n'a plus d'effet
  du tout : il est ignoré.
- Aucun code d'un tiers n'est jamais exécuté par la CI (pas d'équivalent
  `pull_request_target` checkoutant du code externe — il n'y a plus de PR
  du tout dans ce flux).
- La répétition d'une même proposition canonique a un rendement marginal
  décroissant (`1/n`), implémenté dans `scripts/process-graph.mjs`.
- **Les deux chemins de publication produisent la même Issue, traitée
  identiquement.** Que la soumission passe par le lien pré-rempli ou par
  l'API directe, `process-submission.yml` voit exactement le même corps
  d'Issue et applique exactement la même validation — le choix du chemin
  ne change rien aux garanties décrites ici.
- **Le token OAuth stocké côté client** (`localStorage`, jamais envoyé à
  un serveur à nous) a un scope volontairement étroit (`public_repo`) —
  il permet d'ouvrir des issues sur des dépôts publics, rien de plus. Le
  relais (`proxy/worker.js`) ne le voit jamais : il n'intervient que dans
  l'échange initial (device_code → token), jamais dans son usage.

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
- **Qualité de l'extraction sémantique serveur.** Le modèle utilisé par
  `scripts/semantic-extract.mjs` (`Xenova/TinyLlama-1.1B-Chat-v1.0`,
  compatible ONNX/transformers.js) n'a **pas pu être validé en conditions
  réelles** au moment où ce pipeline a été écrit — la disponibilité et le
  comportement exact des modèles de génération de texte avec
  transformers.js évoluent vite, et ce choix n'a été vérifié que sur sa
  logique de parsing/repli, pas sur une véritable génération. Si
  l'extraction échoue systématiquement en production (le repli minimal se
  déclenchant à chaque soumission), commencez par ce nom de modèle. Le
  repli minimal garantit que le pipeline avance toujours, au prix de
  nœuds peu informatifs en attendant.
- **Le rate-limiting par compte est un disjoncteur, pas une preuve
  d'humanité.** Il protège contre un seul compte qui inonde la file plus
  vite que le rendement décroissant ne peut absorber, pas contre la
  création massive de comptes.

## Fonctionnalités implémentées

- **Publication directe et invisible (optionnelle)** (`src/oauth.js`,
  `src/github-api.js`, `proxy/worker.js`) : Device Flow OAuth sans
  client secret, autorisation unique par navigateur, puis appels API
  directs (`fetch()` vers `api.github.com`, CORS natif) pour chaque
  soumission suivante — plus aucune redirection vers GitHub après la
  première connexion. Se replie automatiquement sur le lien pré-rempli si
  `src/config.js` n'est pas configuré. Voir "Publication : deux chemins"
  ci-dessus.
- **Extraction sémantique côté serveur** (`scripts/semantic-extract.mjs`) :
  seule source de vérité pour la structure d'une proposition, calculée à
  partir du seul `text` soumis — jamais d'un bloc `semantic` client. Voir
  "Pourquoi l'extraction sémantique tourne maintenant côté serveur"
  ci-dessus.
- **Canonicalisation déterministe** (`scripts/canonical.mjs`), appliquée à
  la structure extraite côté serveur ci-dessus, jamais à une structure
  déclarée par le client.
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
  valeurs et ne devrait donc pas porter tout le poids du score. Les arêtes
  `similaire` (voir plus bas) sont explicitement exclues de ce calcul, pour
  ne pas diluer la dispersion avec des paraphrases proches.
- **Stabilité par engagement, pas seulement par âge** (`stability`) : la
  persistance temporelle (âge/30 jours) plafonne désormais à 0.4 si la
  proposition n'a jamais été reprise, reliée ou contestée depuis sa première
  apparition. Le reste du score dépend de deux signaux structurels sans
  identité de contributeur : réapparitions au-delà de la première, et
  nombre d'arêtes accumulées.
- **Moteur de relations élargi** : type `questionne`, en plus des sept
  d'origine (`implique`, `contredit`, `complete`, `generalise`,
  `specialise`, `alternative_a`, `depend_de`), pour les contributions qui
  posent une question sans prendre position — le cas central du document
  fondateur ("Comment financer cette transition ?"), qui n'avait
  auparavant nulle part où aller dans le graphe.
- **Arêtes `similaire` auto-générées** (`scripts/process-graph.mjs`,
  `upsertSimilarityEdges`) : deux nœuds distincts (donc pas fusionnés par
  `canonical_key`) dont les embeddings dépassent un seuil de proximité
  élevé (0.72, volontairement plus haut que le seuil de correspondance
  `target_hint` → concept) sont désormais reliés par une arête visible dans
  `data/graph.json`, rendue en pointillés dans l'interface pour rester
  distincte des relations affirmées. Avant ce changement, deux paraphrases
  restaient visuellement sans lien entre elles malgré une proximité
  sémantique forte.
- **Normalisation du domaine et des relations dans l'aperçu client**
  (`src/semantic.js`) : le petit modèle local (`Llama-3.2-1B-Instruct`) ne
  respecte pas toujours à la lettre la consigne d'enum fermé — il peut
  produire une phrase libre au lieu d'une des dix valeurs de `domaine`
  attendues. Cette valeur est normalisée et ramenée à `autre` si elle ne
  correspond à rien de connu. Purement cosmétique depuis que l'extraction
  serveur est indépendante (`scripts/semantic-extract.mjs` applique le
  même clamp de son côté, séparément) : ça évite juste un aperçu
  incohérent avant publication, ça n'affecte plus rien côté identité.
- **Suivi de soumission côté client** (`src/tracker.js`, panneau "Vos
  soumissions") : le flux Issues ne renvoie aucune notification vers le
  site une fois l'utilisateur reparti sur GitHub. Ce module retient
  localement (`localStorage`, pas de compte) un identifiant de
  corrélation généré côté client (`ref`, sans aucun rôle protocolaire) et
  interroge l'API Search publique de GitHub pour retrouver l'Issue
  correspondante (limitée à 10 req/min sans authentification — pas de
  polling automatique en boucle, seulement au chargement et sur clic
  explicite). Une fois l'Issue acceptée, le VRAI `canonical_key` — celui
  que le serveur a calculé, jamais deviné côté client — est extrait du
  commentaire de clôture posté par le workflow, puis utilisé pour mettre
  en évidence le nœud correspondant dans le graphe dès qu'il y apparaît.
- **Recherche pure, séparée de la soumission** (bouton "Rechercher") :
  consulte le graphe par similarité d'embedding sur le texte brut de la
  requête, sans passer par le modèle génératif WebLLM (`src/semantic.js`,
  qui nécessite WebGPU) ni préparer la moindre soumission. Les résultats
  s'affichent classés par similarité ; cliquer un résultat met en évidence
  le nœud correspondant dans le graphe. Distinct du champ "Envoyer", qui
  lui construit une représentation sémantique complète en vue d'une
  soumission — deux opérations différentes qui partageaient auparavant le
  même bouton.
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

- **Flux OAuth direct non testé de bout en bout en conditions réelles.**
  La logique de `src/oauth.js`/`src/github-api.js`/`proxy/worker.js` a été
  vérifiée point par point (support CORS réel de `api.github.com` confirmé
  par requête directe, absence de CORS sur les endpoints Device Flow
  confirmée de la même façon, exigences du Device Flow vérifiées dans la
  documentation GitHub), mais je n'ai pas pu réaliser une autorisation
  Device Flow complète moi-même — ça suppose un compte GitHub humain
  cliquant "Authorize", ce qu'un environnement automatisé ne peut pas
  simuler. Testez ce chemin en premier après déploiement si quelque chose
  ne fonctionne pas comme prévu.

- **Modèle d'extraction serveur non vérifié en conditions réelles, et
  latence associée.** Voir "Modèle de sécurité" ci-dessus — le choix de
  modèle dans `scripts/semantic-extract.mjs` est un point à surveiller en
  priorité si le pipeline se rabat systématiquement sur l'extraction
  minimale. Chaque soumission prend désormais potentiellement plusieurs
  dizaines de secondes à traiter (génération CPU), contre quelques
  centaines de millisecondes avant ce changement (qui ne calculait qu'un
  embedding côté serveur, jamais de génération de texte).
- **Seuil des arêtes `similaire` non calibré empiriquement.** 0.72 est un
  choix raisonnable mais arbitraire, posé sans jeu de données réel pour le
  valider — à ajuster une fois qu'il y aura assez de soumissions pour
  observer si le graphe sur-connecte (seuil trop bas) ou sous-connecte
  (trop haut) les paraphrases.
- **Le 5ᵉ axe "diversité structurelle" (proposé dans les échanges de
  conception, distinct de la nouveauté par le *contenu*) n'est pas
  implémenté.** Ce qu'il capturerait précisément au-delà de `novelty` et
  `bridge` reste à démontrer sur des cas réels avant de lui donner sa
  propre formule — ajouté à la légère, il ferait probablement double
  emploi.
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
