export const DOC_GROUPS = ["system", "methodology", "design"] as const;
export type DocGroup = (typeof DOC_GROUPS)[number];

export interface PublicDoc {
  /** Filename within /docs. Keep this to a single checked-in Markdown filename. */
  source: string;
  /** URL slug at /docs/<slug>/. */
  slug: string;
  /** Short human title for the index page. */
  title: string;
  /** One-sentence summary for index pages, llms.txt, metadata, and markdown front matter. */
  summary: string;
  /** Group for index-page grouping and llms.txt ordering. */
  group: DocGroup;
}

export const PUBLIC_DOCS: readonly PublicDoc[] = [
  {
    source: "api-reference.md",
    slug: "api-reference",
    title: "API Reference",
    summary: "HTTP contracts, authentication notes, and response conventions.",
    group: "system",
  },
  {
    source: "architecture.md",
    slug: "architecture",
    title: "Architecture",
    summary: "Route map, API surfaces, runtime rules, and SEO ownership.",
    group: "system",
  },
  {
    source: "data-flow-map.md",
    slug: "data-flow-map",
    title: "Data Flow Map",
    summary: "End-to-end source-to-UI flows for each major data domain.",
    group: "system",
  },
  {
    source: "data-pipeline.md",
    slug: "data-pipeline",
    title: "Data Pipeline",
    summary: "Price enrichment, integrity guardrails, and sync behavior.",
    group: "system",
  },
  {
    source: "worker-and-api-limits.md",
    slug: "worker-and-api-limits",
    title: "Worker and API Limits",
    summary: "Repo-enforced runtime limits, cron budgets, and polling guidance.",
    group: "system",
  },
  {
    source: "classification.md",
    slug: "classification",
    title: "Classification",
    summary: "Classification system, peg handling, and commodity treatment.",
    group: "methodology",
  },
  {
    source: "pricing-pipeline.md",
    slug: "pricing-pipeline",
    title: "Pricing Pipeline",
    summary: "Live-price consensus, overrides, and fallback enrichment.",
    group: "methodology",
  },
  {
    source: "depeg-detection.md",
    slug: "depeg-detection",
    title: "Depeg Detection",
    summary: "Two-stage detection, confirmation, and peg score inputs.",
    group: "methodology",
  },
  {
    source: "dews.md",
    slug: "dews",
    title: "DEWS",
    summary: "DEWS formula, sub-signals, bands, and API contract.",
    group: "methodology",
  },
  {
    source: "dex-liquidity.md",
    slug: "dex-liquidity",
    title: "DEX Liquidity",
    summary: "Liquidity score, discovery pipeline, and cross-validation.",
    group: "methodology",
  },
  {
    source: "stability-index.md",
    slug: "stability-index",
    title: "Pharos Stability Index",
    summary: "PSI formula, bands, storage, and API surface.",
    group: "methodology",
  },
  {
    source: "report-cards.md",
    slug: "report-cards",
    title: "Report Cards",
    summary: "Report-card scoring, portfolio analyzer, and stress test.",
    group: "methodology",
  },
  {
    source: "redemption-backstops.md",
    slug: "redemption-backstops",
    title: "Redemption Backstops",
    summary: "Redemption routes, effective-exit scoring, and storage.",
    group: "methodology",
  },
  {
    source: "chain-health.md",
    slug: "chain-health",
    title: "Chain Health",
    summary: "Chain Health Score inputs, formula, factors, and bands.",
    group: "methodology",
  },
  {
    source: "pharosville-page.md",
    slug: "pharosville-page",
    title: "PharosVille Page",
    summary: "The PharosVille route, desktop gate, canvas exception, and data-to-world contract.",
    group: "system",
  },
  {
    source: "mint-burn-flows.md",
    slug: "mint-burn-flows",
    title: "Mint Burn Flows",
    summary: "Mint/burn ingestion, scoring, and admin backfills.",
    group: "methodology",
  },
  {
    source: "yield-intelligence.md",
    slug: "yield-intelligence",
    title: "Yield Intelligence",
    summary: "APY resolution, PYS scoring, and warning signals.",
    group: "methodology",
  },
  {
    source: "shadow-stablecoins.md",
    slug: "shadow-stablecoins",
    title: "Shadow Stablecoins",
    summary: "PSI-only shadow asset boundary and UI exclusion rules.",
    group: "methodology",
  },
  {
    source: "design-context.md",
    slug: "design-context",
    title: "Design Context",
    summary: "User, brand, and product-direction baseline.",
    group: "design",
  },
  {
    source: "design-language.md",
    slug: "design-language",
    title: "Design Language",
    summary: "Live UI patterns, typography, spacing, and responsive rules.",
    group: "design",
  },
  {
    source: "design-tokens.md",
    slug: "design-tokens",
    title: "Design Tokens",
    summary: "Token layers and CSS variable architecture.",
    group: "design",
  },
] as const;

export const PUBLIC_DOC_BY_SLUG = new Map(PUBLIC_DOCS.map((doc) => [doc.slug, doc]));
const PUBLIC_DOC_BY_SOURCE = new Map(PUBLIC_DOCS.map((doc) => [doc.source, doc]));

function stripLeadingMarkdownH1(source: string): string {
  if (!source.startsWith("# ")) return source;
  const firstLineBreak = source.indexOf("\n");
  if (firstLineBreak === -1) return "";
  return source.slice(firstLineBreak + 1).replace(/^\r?\n/, "");
}

export function resolvePublicDocHref(
  href: string | undefined,
  { absolute = false }: { absolute?: boolean } = {},
): string | undefined {
  if (!href) return undefined;
  if (/^(https?:|mailto:|#|\/)/.test(href)) return href;

  const [target = "", hash = ""] = href.split("#");
  const normalized = target.replace(/^\.\//, "");
  if (!normalized.endsWith(".md")) return undefined;

  const doc = PUBLIC_DOC_BY_SOURCE.get(normalized);
  if (!doc) return undefined;

  const path = `/docs/${doc.slug}/${hash ? `#${hash}` : ""}`;
  return absolute ? `https://pharos.watch${path}` : path;
}

function rewritePublicDocLinks(markdown: string, { absolute = false }: { absolute?: boolean } = {}): string {
  return markdown.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (full, label: string, href: string) => {
    const resolved = resolvePublicDocHref(href, { absolute });
    if (resolved) return `[${label}](${resolved})`;
    if (/^(https?:|mailto:|#|\/)/.test(href)) return full;
    return label;
  });
}

function redactPublicDocSource(markdown: string, source?: string): string {
  const withoutAgentPaths = markdown
    .replace(/agents\/[^\s)`]+/g, "internal working notes")
    .replace(/AGENTS\.md/g, "agent instructions");
  if (source !== "api-reference.md") return withoutAgentPaths;
  const adminAuthIndex = withoutAgentPaths.indexOf("\n## Admin Auth And Idempotency");
  const publicEndpointsIndex = withoutAgentPaths.indexOf("\n## Public Endpoints");
  const withoutAdminAuth =
    adminAuthIndex >= 0 && publicEndpointsIndex > adminAuthIndex
      ? `${withoutAgentPaths.slice(0, adminAuthIndex)}\n${withoutAgentPaths.slice(publicEndpointsIndex)}`
      : withoutAgentPaths;
  const adminEndpointsIndex = withoutAdminAuth.indexOf("\n## Admin Endpoints");
  return adminEndpointsIndex >= 0 ? withoutAdminAuth.slice(0, adminEndpointsIndex).trimEnd() : withoutAdminAuth;
}

export function preparePublicDocMarkdown(
  markdown: string,
  {
    absoluteLinks = false,
    source,
    stripTitle = false,
  }: { absoluteLinks?: boolean; source?: string; stripTitle?: boolean } = {},
): string {
  const redacted = redactPublicDocSource(markdown, source);
  const withoutTitle = stripTitle ? stripLeadingMarkdownH1(redacted) : redacted;
  return rewritePublicDocLinks(withoutTitle, { absolute: absoluteLinks });
}
