// Relais minimal, SANS SECRET — sert UNIQUEMENT à contourner l'absence de
// CORS sur les deux endpoints d'échange OAuth Device Flow de GitHub
// (login/device/code, login/oauth/access_token — vérifié : ils répondent
// 404 à une requête OPTIONS, contrairement à api.github.com qui répond
// 204 avec Access-Control-Allow-Origin: *).
//
// Ce relais ne détient AUCUNE donnée sensible : le Device Flow ne
// nécessite pas de client_secret (contrairement au flow "Authorization
// Code" classique) — il n'y a donc rien à protéger ici, juste du CORS à
// ajouter à deux appels. Tout le reste (création d'Issue, lecture de
// statut) passe en appel direct depuis le navigateur vers api.github.com,
// qui supporte CORS nativement — voir src/github-api.js.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: cors });
    }

    let target;
    if (url.pathname === "/device/code") {
      target = "https://github.com/login/device/code";
    } else if (url.pathname === "/device/token") {
      target = "https://github.com/login/oauth/access_token";
    } else {
      return new Response("Not found", { status: 404, headers: cors });
    }

    const body = await request.text();
    const upstream = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
    });

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  },
};
