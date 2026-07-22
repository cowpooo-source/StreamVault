import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (file) => readFileSync(resolve(root, file), "utf8");
const marketing = read("index.html");
const app = read("app.html");

function matches(source, pattern) {
  return [...source.matchAll(pattern)];
}

describe("public SEO and GEO contract", () => {
  it("publishes one canonical, descriptive marketing entry", () => {
    expect(marketing).toContain('<link rel="canonical" href="https://portalheaven.stream/">');
    expect(marketing).toContain('<meta name="robots" content="index, follow, max-image-preview:large">');
    expect(matches(marketing, /<h1(?:\s[^>]*)?>/gi)).toHaveLength(1);
    expect(marketing).toContain("Source-Available IPTV Web Player for Xtream, M3U and Stalker");
    expect(marketing).toContain('href="/app"');
  });

  it("matches public licensing language to the repository license", () => {
    const license = read("../LICENSE");
    expect(license).toContain("PolyForm Noncommercial License 1.0.0");
    expect(marketing).toContain("https://polyformproject.org/licenses/noncommercial/1.0.0/");
    expect(marketing).toContain("PolyForm Noncommercial 1.0.0");
    expect(marketing).not.toMatch(/Apache-2\.0|open-source|open source/i);
    expect(read("public/llms.txt")).toContain("source-available");
  });

  it("provides valid WebApplication structured data without fabricated ratings", () => {
    const block = marketing.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    expect(block).not.toBeNull();
    const data = JSON.parse(block[1]);
    expect(data["@graph"].some((entry) => entry["@type"] === "WebApplication")).toBe(true);
    expect(marketing).not.toMatch(/aggregateRating|reviewRating/i);
  });

  it("keeps the authenticated application out of search results", () => {
    expect(app).toContain('content="noindex, nofollow, noarchive"');
    expect(app).toContain('src="/src/main.jsx"');
    expect(marketing).not.toContain('src="/src/main.jsx"');
  });

  it("launches the installed PWA into the branded application", () => {
    const manifest = JSON.parse(read("public/manifest.json"));
    expect(manifest.id).toBe("/app");
    expect(manifest.start_url).toBe("/app");
    expect(manifest.name).toBe("Portal Heaven Web Player");
    expect(manifest.short_name).toBe("Portal Heaven");
  });

  it("uses optimized, dimensioned marketing images", () => {
    expect(marketing).toContain('src="/hero-marketing.jpg" width="1400" height="742"');
    expect(marketing).toContain('src="/epg-marketing.jpg" width="1200" height="631"');
    expect(marketing).toContain('src="/analytics-marketing.jpg" width="1200" height="637"');
    expect(matches(marketing, /loading="lazy"/g).length).toBeGreaterThanOrEqual(2);
  });

  it("publishes crawler discovery files and excludes private application routes", () => {
    const robots = read("public/robots.txt");
    const sitemap = read("public/sitemap.xml");
    const llms = read("public/llms.txt");
    expect(robots).toContain("User-agent: OAI-SearchBot");
    expect(robots).toContain("Disallow: /app");
    expect(robots).toContain("Sitemap: https://portalheaven.stream/sitemap.xml");
    expect(sitemap).toContain("https://portalheaven.stream/features");
    expect(sitemap).not.toContain("/app</loc>");
    expect(sitemap).not.toContain("/content</loc>");
    expect(llms).toContain("does not provide channels, movies, series or subscriptions");
  });

  it.each(["features", "security", "self-host", "faq", "privacy", "terms"])(
    "publishes the canonical /%s information page",
    (name) => {
      const page = read(`${name}.html`);
      expect(page).toContain(`<link rel="canonical" href="https://portalheaven.stream/${name}">`);
      expect(matches(page, /<h1(?:\s[^>]*)?>/gi)).toHaveLength(1);
    },
  );

  it("publishes concrete hosted-service privacy and contact information", () => {
    const privacy = read("privacy.html");
    expect(privacy).toContain("portalheavenstream@gmail.com");
    expect(privacy).toContain("Cloudflare");
    expect(privacy).toContain("Stripe");
    expect(privacy).toContain("Your choices and rights");
    expect(privacy).not.toMatch(/must list|should be able/i);
  });

  it("keeps the legacy landing URL and 404 page out of the index", () => {
    expect(read("landing.html")).toContain('content="noindex"');
    expect(read("404.html")).toContain('content="noindex, follow"');
  });
});

describe("deployment route contract", () => {
  const nginx = read("../nginx_vps.conf");

  it("serves marketing at the canonical HTTPS root and the app at explicit routes", () => {
    expect(nginx).toContain("location = / { try_files /index.html =404; }");
    expect(nginx).toMatch(/location = \/app \{[\s\S]*?X-Robots-Tag[\s\S]*?try_files \/app\.html =404;/);
    expect(nginx).toMatch(/location = \/content \{[\s\S]*?X-Robots-Tag[\s\S]*?try_files \/app\.html =404;/);
  });

  it("retains security headers in app and content locations", () => {
    for (const route of ["/app", "/content"]) {
      const escaped = route.replace("/", "\\/");
      const block = nginx.match(new RegExp(`location = ${escaped} \\{([\\s\\S]*?)\\n    \\}`));
      expect(block).not.toBeNull();
      expect(block[1]).toContain('X-Robots-Tag "noindex, nofollow"');
      expect(block[1]).toContain('X-Content-Type-Options "nosniff"');
      expect(block[1]).toContain('Referrer-Policy "strict-origin-when-cross-origin"');
      expect(block[1]).toContain("Permissions-Policy");
    }
  });

  it("returns real 404 responses and canonicalizes duplicate URLs", () => {
    expect(nginx).toContain("error_page 404 /404.html;");
    expect(nginx).toContain("location / { try_files $uri =404; }");
    expect(nginx).toContain("return 301 https://portalheaven.stream$request_uri;");
    expect(nginx).toContain("location = /landing.html { return 301 /; }");
  });

  it("documents app-aware redirects and uses Node 22 consistently", () => {
    expect(read("../stalker-proxy/.env.example")).toContain("APP_URL=https://portalheaven.stream/app");
    expect(read("../docker-compose.feature.yml")).toContain("APP_URL=http://localhost:3201/app");
    expect(read("Dockerfile")).toContain("FROM node:22-slim");
    expect(read("../stalker-proxy/Dockerfile")).toContain("FROM node:22-slim");
    expect(JSON.parse(read("package.json")).engines.node).toBe(">=22");
    expect(JSON.parse(read("../stalker-proxy/package.json")).engines.node).toBe(">=22");
  });
});