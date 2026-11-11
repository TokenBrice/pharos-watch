// Source forms preserve the reviewed exact/slash/descendant serving policy.
export const RETIRED_PUBLIC_ROUTES = [
  { prefix: "/telegram", replacement: "/pharoswatchbot/", forms: ["", "/", "/*"], preserveDescendants: true },
  { prefix: "/screener/selector", replacement: "/screener/picker/", forms: ["", "/", "/*"], preserveDescendants: true },
  { prefix: "/mica", replacement: "/compliance/", forms: ["", "/", "/*"], preserveDescendants: true },
  { prefix: "/blacklist", replacement: "/freezewatch/", forms: ["", "/", "/*"], preserveDescendants: true },
  { prefix: "/report-cards", replacement: "/safety-scores/", forms: ["", "/", "/*"], preserveDescendants: true },
  { prefix: "/risk-lab", replacement: "/safety-scores/", forms: ["", "/", "/*"], preserveDescendants: true },
  { prefix: "/peg-tracker", replacement: "/", forms: ["", "/"] },
  { prefix: "/stability-index-alt", replacement: "/stability-index/", forms: ["", "/", "/*"], preserveDescendants: true },
  { prefix: "/tape", replacement: "/timeline/", forms: ["", "/", "/*"], preserveDescendants: true },
  { prefix: "/stablecoins/protocol/liquity-v1", replacement: "/stablecoins/infrastructure/liquity-v1/", forms: ["", "/*"], preserveDescendants: true },
  { prefix: "/stablecoins/protocol/liquity-v2", replacement: "/stablecoins/infrastructure/liquity-v2/", forms: ["", "/*"], preserveDescendants: true },
  { prefix: "/stablecoins/protocol/liquity", replacement: "/stablecoins/infrastructure/liquity-v1/", forms: ["", "/*"], preserveDescendants: true },
  { prefix: "/about/principles", replacement: "/about/", forms: ["", "/*"] },
  { prefix: "/about/editorial", replacement: "/about/", forms: ["", "/*"] },
  { prefix: "/about/style", replacement: "/about/", forms: ["", "/*"] },
  { prefix: "/sitemap-tree", replacement: "/", forms: ["", "/", "/*"] },
  { prefix: "/start", replacement: "/", forms: ["", "/", "/*"] },
  { prefix: "/about/bluechip", replacement: "/about/#bluechip", forms: ["", "/", "/*"] },
  { prefix: "/docs/architecture", replacement: "/docs/", forms: ["", "/", "/*"] },
  { prefix: "/docs/worker-and-api-limits", replacement: "/docs/", forms: ["", "/", "/*"] },
  { prefix: "/docs/data-flow-map", replacement: "/docs/", forms: ["", "/", "/*"] },
  { prefix: "/docs/design-language", replacement: "/docs/", forms: ["", "/", "/*"] },
  { prefix: "/docs/design-tokens", replacement: "/docs/", forms: ["", "/", "/*"] },
  { prefix: "/stablecoin/pusd-pleasing", replacement: "/stablecoins/usd/", forms: ["", "/*"] },
  { prefix: "/stablecoin/phpc-coins-ph", replacement: "/coverage/", forms: ["", "/*"] },
  { prefix: "/feed/digest", replacement: "/feed/digest.xml", forms: ["", "/"] },
  { prefix: "/feed/depeg", replacement: "/feed/depeg.xml", forms: ["", "/"] },
  { prefix: "/feed/methodology", replacement: "/feed/methodology.xml", forms: ["", "/"] },
  { prefix: "/feed/cemetery", replacement: "/feed/cemetery.xml", forms: ["", "/"] },
  { prefix: "/methodology/pdf", replacement: "/methodology/", forms: ["", "/", "/*"] },
];

export const RETIRED_PUBLIC_ROUTE_REDIRECTS = RETIRED_PUBLIC_ROUTES.flatMap((route) =>
  route.forms.map((form) => ({
    source: `${route.prefix}${form}`,
    destination: `${route.replacement}${form === "/*" && route.preserveDescendants ? ":splat" : ""}`,
    status: "301",
  })),
);

/** Preserve existing layout; emit missing static rules before every dynamic rule. */
export function projectRetiredPublicRouteRedirects(contents) {
  const rules = new Map(RETIRED_PUBLIC_ROUTE_REDIRECTS.map((rule) => [rule.source, rule]));
  const seen = new Set();
  const lines = contents.split("\n").map((line) => {
    const parts = /^(\S+)([ \t]+)(\S+)([ \t]+)(\d+)([ \t]*)$/.exec(line);
    if (!parts) return line;
    const [, source, beforeDestination, , beforeStatus, , trailing] = parts;
    const rule = rules.get(source);
    seen.add(source);
    return rule ? `${source}${beforeDestination}${rule.destination}${beforeStatus}${rule.status}${trailing}` : line;
  });
  const missing = [...rules.values()].filter((rule) => !seen.has(rule.source));
  const renderRule = (rule) => `${rule.source} ${rule.destination} ${rule.status}`;
  const staticRules = missing.filter((rule) => !rule.source.includes("*")).map(renderRule);
  const dynamicRules = missing.filter((rule) => rule.source.includes("*")).map(renderRule);
  if (staticRules.length > 0) {
    const firstDynamic = lines.findIndex((line) => {
      const source = line.split(/\s+/, 1)[0];
      return !source.startsWith("#") && /[*:]/.test(source);
    });
    const end = lines.at(-1) === "" ? lines.length - 1 : lines.length;
    lines.splice(firstDynamic < 0 ? end : firstDynamic, 0, ...staticRules);
  }
  if (dynamicRules.length > 0) {
    const end = lines.at(-1) === "" ? lines.length - 1 : lines.length;
    lines.splice(end, 0, ...dynamicRules);
  }
  return lines.join("\n");
}
