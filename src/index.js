// decentralised.si is the canonical website. Every other brand domain serves the
// same Worker and redirects here, so there is one origin (one dashboard session).
const CANONICAL = "decentralised.si";
const ALIASES = new Set([
  "www.decentralised.si",
  "decentralise.si",
  "www.decentralise.si",
  "decentralised.ai",
  "www.decentralised.ai",
  "decentralise.ai",
  "www.decentralise.ai",
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
