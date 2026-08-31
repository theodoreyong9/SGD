// Dépôt cible des Issues de soumission.
export const OWNER = "theodoreyong9";
export const REPO = "SGD";

// URL de votre relais Cloudflare Worker (voir proxy/, à déployer
// séparément) — sert UNIQUEMENT à contourner l'absence de CORS sur les 2
// endpoints d'échange OAuth Device Flow, jamais à protéger un secret (le
// Device Flow n'en utilise pas). Voir README "Mise en place".
export const PROXY_URL = "https://sgd.yourminedapp.workers.dev";

// Client ID de votre OAuth App GitHub (Settings → Developer settings →
// OAuth Apps → New OAuth App, avec "Enable Device Flow" coché dans les
// réglages de l'app après création). Donnée PUBLIQUE — contrairement au
// client secret, elle est prévue pour apparaître dans du code exécuté
// côté client.
export const OAUTH_CLIENT_ID = "Ov23liXVsyy8PAYiHVZw";

// isOAuthConfigured(): tant que ces valeurs sont encore les placeholders
// ci-dessus, l'app se replie automatiquement sur le flux "lien pré-rempli"
// (voir src/publish.js) plutôt que de casser — une soumission reste
// possible dès la livraison, avant même que quelqu'un configure OAuth.
export function isOAuthConfigured() {
  return (
    OAUTH_CLIENT_ID !== "YOUR_OAUTH_CLIENT_ID" &&
    PROXY_URL !== "https://YOUR-WORKER-SUBDOMAIN.workers.dev"
  );
}
