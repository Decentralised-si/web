// decentralised.si is the canonical website. The .ai domains have their own landing page
// (the network story) at "/"; every other path on an alias domain redirects to the canonical
// site so there is one origin (one app session).
//
// The intro film (/intro) plays before the landing page on a visitor's first visit to "/".
// Finishing it, or choosing "Skip intro" / "Enter the site" (/?intro=skip), sets a cookie so
// later visits go straight to the landing page. Crawlers and link-preview bots always get the
// landing page.
const CANONICAL = "decentralised.si";
const AI_HOSTS = new Set(["decentralised.ai", "www.decentralised.ai", "decentralise.ai", "www.decentralise.ai"]);
const ALIASES = new Set(["www.decentralised.si", "decentralise.si", "www.decentralise.si", ...AI_HOSTS]);
const SEEN = "dsi_intro=seen";
const BOTS = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|whatsapp|telegram|discord|slack|linkedin|twitter|pinterest|vkshare|quora|redditbot|applebot|bingpreview|headless/i;

function withHeaders(res, extra) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(extra)) r.headers.set(k, v);
  return r;
}

async function asset(env, request, url, pathname) {
  const u = new URL(url);
  u.pathname = pathname;
  u.search = "";
  return env.ASSETS.fetch(new Request(u, request));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isAi = AI_HOSTS.has(url.hostname);

    // Only redirect once the canonical domain actually resolves; until then every alias serves the site itself.
    if (env.CANONICAL_LIVE === "true" && ALIASES.has(url.hostname) && !(isAi && url.pathname === "/")) {
      url.hostname = CANONICAL;
      url.protocol = "https:";
      url.port = "";
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === "/") {
      if (url.searchParams.get("intro") === "skip") {
        url.searchParams.delete("intro");
        return new Response(null, {
          status: 302,
          headers: {
            location: url.pathname + url.search,
            "set-cookie": `${SEEN}; Max-Age=2592000; Path=/; Secure; SameSite=Lax`,
            "cache-control": "no-store",
          },
        });
      }
      const seen = (request.headers.get("cookie") || "").split(/;\s*/).includes(SEEN);
      const bot = BOTS.test(request.headers.get("user-agent") || "");
      const landing = isAi ? "/ai" : "/";
      const res = !seen && !bot ? await asset(env, request, url, "/intro") : await asset(env, request, url, landing);
      return withHeaders(res, { "cache-control": "private, no-cache", vary: "Cookie, User-Agent" });
    }

    return env.ASSETS.fetch(request);
  },
};
