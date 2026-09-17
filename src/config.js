// Target repo for submission Issues.
export const OWNER = "theodoreyong9";
export const REPO = "SGD";

// URL of your Cloudflare Worker relay (see proxy/, to be deployed
// separately) — used ONLY to work around the lack of CORS on the 2
// OAuth Device Flow exchange endpoints, never to protect a secret (the
// Device Flow doesn't use one). See README "Setup".
export const PROXY_URL = "https://sgd.yourminedapp.workers.dev";

// Client ID of your GitHub OAuth App (Settings → Developer settings →
// OAuth Apps → New OAuth App, with "Enable Device Flow" checked in the
// app's settings after creation). PUBLIC data — unlike the client
// secret, it's meant to appear in code that runs client-side.
export const OAUTH_CLIENT_ID = "Ov23liXVsyy8PAYiHVZw";

// isOAuthConfigured(): as long as these values are still the
// placeholders above, the app automatically falls back to the
// "pre-filled link" flow (see src/publish.js) rather than breaking — a
// submission stays possible from day one, even before anyone configures
// OAuth.
export function isOAuthConfigured() {
  return (
    OAUTH_CLIENT_ID !== "YOUR_OAUTH_CLIENT_ID" &&
    PROXY_URL !== "https://YOUR-WORKER-SUBDOMAIN.workers.dev"
  );
}
