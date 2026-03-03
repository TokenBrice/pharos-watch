import fs from "node:fs";
import path from "node:path";

const OUT_DIR = path.resolve("out");
const BAILOUT_PATTERN = /BAILOUT_TO_CLIENT_SIDE_RENDERING|next-dynamic-bailout-to-csr/;

function walkIndexFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "_next") continue;
      results.push(...walkIndexFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name === "index.html") {
      results.push(fullPath);
    }
  }
  return results;
}

function routeFromFile(filePath) {
  const relDir = path.relative(OUT_DIR, path.dirname(filePath)).replace(/\\/g, "/");
  if (!relDir) return "/";
  return `/${relDir}/`;
}

function extractAttr(html, regex) {
  const match = html.match(regex);
  return match?.[1] ?? "";
}

function isIndexable(robots) {
  return !/noindex/i.test(robots || "");
}

function normalizeHref(href) {
  if (!href) return null;
  if (
    href.startsWith("#") ||
    href.startsWith("mailto:") ||
    href.startsWith("tel:") ||
    href.startsWith("javascript:")
  ) {
    return null;
  }

  try {
    let target = href;
    if (target.startsWith("http://") || target.startsWith("https://")) {
      const parsed = new URL(target);
      if (parsed.hostname !== "pharos.watch") return null;
      target = parsed.pathname;
    }

    target = target.split("#")[0].split("?")[0];
    if (!target.startsWith("/")) return null;
    return target.endsWith("/") ? target : `${target}/`;
  } catch {
    return null;
  }
}

function parseSitemapLocs(xml) {
  const locs = [];
  const re = /<loc>([^<]+)<\/loc>/g;
  let m = re.exec(xml);
  while (m) {
    locs.push(m[1]);
    m = re.exec(xml);
  }
  return new Set(locs);
}

function fail(errors, warning = []) {
  for (const w of warning) {
    console.warn(`WARN: ${w}`);
  }
  for (const e of errors) {
    console.error(`ERROR: ${e}`);
  }
  process.exit(1);
}

function main() {
  if (!fs.existsSync(OUT_DIR)) {
    fail([`Missing build output directory: ${OUT_DIR}`]);
  }

  const indexFiles = walkIndexFiles(OUT_DIR);
  const pageRecords = indexFiles.map((filePath) => {
    const html = fs.readFileSync(filePath, "utf8");
    return {
      filePath,
      route: routeFromFile(filePath),
      html,
      title: extractAttr(html, /<title>([^<]*)<\/title>/i),
      description: extractAttr(html, /<meta name="description" content="([^"]*)"/i),
      canonical: extractAttr(html, /<link rel="canonical" href="([^"]+)"/i),
      ogTitle: extractAttr(html, /<meta property="og:title" content="([^"]*)"/i),
      ogDescription: extractAttr(html, /<meta property="og:description" content="([^"]*)"/i),
      twitterCard: extractAttr(html, /<meta name="twitter:card" content="([^"]*)"/i),
      robots: extractAttr(html, /<meta name="robots" content="([^"]*)"/i),
      h1Count: (html.match(/<h1\b/gi) ?? []).length,
    };
  });

  const errors = [];
  const warnings = [];

  for (const record of pageRecords) {
    if (BAILOUT_PATTERN.test(record.html)) {
      errors.push(`${record.route}: CSR bailout marker found in HTML`);
    }

    if (!record.title) errors.push(`${record.route}: missing <title>`);
    if (!record.description) errors.push(`${record.route}: missing meta description`);
    if (!record.canonical) errors.push(`${record.route}: missing canonical`);
    if (!record.ogTitle) errors.push(`${record.route}: missing og:title`);
    if (!record.ogDescription) errors.push(`${record.route}: missing og:description`);
    if (!record.twitterCard) errors.push(`${record.route}: missing twitter:card`);

    if (isIndexable(record.robots) && record.h1Count !== 1) {
      errors.push(`${record.route}: expected exactly one <h1> on indexable page, got ${record.h1Count}`);
    }
  }

  const routeSet = new Set(pageRecords.map((p) => p.route));
  const graph = new Map();
  const inbound = new Map();
  for (const route of routeSet) {
    graph.set(route, new Set());
    inbound.set(route, 0);
  }

  for (const record of pageRecords) {
    const hrefRegex = /<a\b[^>]*href="([^"]+)"/gi;
    let match = hrefRegex.exec(record.html);
    while (match) {
      const normalized = normalizeHref(match[1]);
      if (normalized && routeSet.has(normalized)) {
        graph.get(record.route).add(normalized);
        inbound.set(normalized, (inbound.get(normalized) ?? 0) + 1);
      }
      match = hrefRegex.exec(record.html);
    }
  }

  const depth = new Map();
  const queue = ["/"];
  depth.set("/", 0);

  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i];
    const currentDepth = depth.get(current) ?? 0;
    for (const next of graph.get(current) ?? []) {
      if (!depth.has(next)) {
        depth.set(next, currentDepth + 1);
        queue.push(next);
      }
    }
  }

  for (const record of pageRecords) {
    if (!isIndexable(record.robots)) continue;

    const d = depth.get(record.route);
    if (d === undefined) {
      errors.push(`${record.route}: indexable page is unreachable from homepage`);
      continue;
    }
    if (d > 3) {
      errors.push(`${record.route}: indexable page depth is ${d} clicks (must be <= 3)`);
    }

    if (record.route !== "/" && (inbound.get(record.route) ?? 0) === 0) {
      errors.push(`${record.route}: indexable orphan page has zero internal inbound links`);
    }
  }

  const sitemapPath = path.join(OUT_DIR, "sitemap.xml");
  if (!fs.existsSync(sitemapPath)) {
    errors.push("out/sitemap.xml missing");
  } else {
    const sitemapXml = fs.readFileSync(sitemapPath, "utf8");
    const locs = parseSitemapLocs(sitemapXml);
    if (!locs.has("https://pharos.watch/stability-index/")) {
      errors.push("sitemap.xml missing https://pharos.watch/stability-index/");
    }
    if (locs.has("https://pharos.watch/stability-index-alt/")) {
      errors.push("sitemap.xml should not include https://pharos.watch/stability-index-alt/");
    }

    const pageUrlSet = new Set(
      pageRecords
        .filter((p) => isIndexable(p.robots))
        .map((p) => `https://pharos.watch${p.route === "/" ? "/" : p.route}`),
    );

    const missingFromSitemap = [...pageUrlSet].filter((url) => !locs.has(url));
    if (missingFromSitemap.length > 0) {
      errors.push(
        `indexable pages missing from sitemap.xml: ${missingFromSitemap.slice(0, 10).join(", ")}${missingFromSitemap.length > 10 ? " ..." : ""}`,
      );
    }
  }

  // Informational warning only: avoids failing CI for transient route count changes.
  warnings.push(`Checked ${pageRecords.length} HTML pages in out/`);

  if (errors.length > 0) {
    fail(errors, warnings);
  }

  for (const w of warnings) {
    console.log(`OK: ${w}`);
  }
  console.log("OK: SEO static checks passed");
}

main();
