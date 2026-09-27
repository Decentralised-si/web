// decentralised.si is the canonical website. The .ai domains have their own landing page
// (the network story) at "/"; every other path on an alias domain redirects to the canonical
// site so there is one origin (one app session).
const CANONICAL = "decentralised.si";
const AI_HOSTS = new Set(["decentralised.ai", "www.decentralised.ai", "decentralise.ai", "www.decentralise.ai"]);
const ALIASES = new Set(["www.decentralised.si", "decentralise.si", "www.decentralise.si", ...AI_HOSTS]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (AI_HOSTS.has(url.hostname) && url.pathname === "/") {
      url.pathname = "/ai";
      return env.ASSETS.fetch(new Request(url, request));
    }
    // Only redirect once the canonical domain actually resolves; until then every alias serves the site itself.
    if (env.CANONICAL_LIVE === "true" && ALIASES.has(url.hostname)) {
      url.hostname = CANONICAL;
      url.protocol = "https:";
      url.port = "";
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
