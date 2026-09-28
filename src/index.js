// decentralised.si is the canonical website. The .ai domains have their own landing page
// (the network story) at "/"; every other path on an alias domain redirects to the canonical
// site so there is one origin (one app session).
//
// The intro film (/intro) is what "/" shows whenever someone arrives from outside the site
// (typed address, bookmark, a link elsewhere). Navigating within the site (logo, "Home",
// "Enter the site" / "Skip intro" = /?intro=skip) goes to the landing page: a same-site
// Referer, or a 30-minute cookie for browsers that strip the Referer. Crawlers and
// link-preview bots always get the landing page.
const CANONICAL = "decentralised.si";
const AI_HOSTS = new Set(["decentralised.ai", "www.decentralised.ai", "decentralise.ai", "www.decentralise.ai"]);
const ALIASES = new Set(["www.decentralised.si", "decentralise.si", "www.decentralise.si", ...AI_HOSTS]);
const ENTERED = "dsi_entered=1";
const SITE_HOSTS = new Set([CANONICAL, ...ALIASES]);
// Pages and files renamed since publication.
const MOVED = { "/install/oifd.sh": "/install/synapse.sh", "/install/oifd.ps1": "/install/synapse.ps1" };
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
    if (MOVED[url.pathname]) return Response.redirect(new URL(MOVED[url.pathname], url).toString(), 301);

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
            "set-cookie": `${ENTERED}; Max-Age=1800; Path=/; Secure; SameSite=Lax`,
            "cache-control": "no-store",
          },
        });
      }
      let fromSite = false;
      try {
        fromSite = SITE_HOSTS.has(new URL(request.headers.get("referer") || "").hostname);
      } catch {}
      const seen = fromSite || (request.headers.get("cookie") || "").split(/;\s*/).includes(ENTERED);
      const bot = BOTS.test(request.headers.get("user-agent") || "");
      const landing = isAi ? "/ai" : "/";
      const res = !seen && !bot ? await asset(env, request, url, "/intro") : await asset(env, request, url, landing);
      return withHeaders(res, { "cache-control": "private, no-cache", vary: "Cookie, User-Agent, Referer" });
    }

    return env.ASSETS.fetch(request);
  },
};
