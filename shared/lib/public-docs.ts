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
    summary:
      "Public Pharos API contracts for stablecoin data: endpoints, authentication, response schemas, pagination, freshness headers, and dataset exports.",
    group: "system",
  },
  {
    source: "architecture.md",
    slug: "architecture",
    title: "Architecture",
    summary:
      "How Pharos is built: static Next.js export, Cloudflare Pages Functions, Worker API lanes, D1 storage, route ownership, and SEO metadata rules.",
    group: "system",
  },
  {
    source: "data-flow-map.md",
    slug: "data-flow-map",
    title: "Data Flow Map",
    summary:
      "Source-to-UI map for Pharos stablecoin data, covering market prices, peg monitoring, liquidity, report cards, alerts, and generated public artifacts.",
    group: "system",
  },
  {
    source: "data-pipeline.md",
    slug: "data-pipeline",
    title: "Data Pipeline",
    summary:
      "Stablecoin data pipeline guide for price enrichment, source priority, freshness checks, integrity guardrails, fallback behavior, and sync cadence.",
    group: "system",
  },
  {
    source: "worker-and-api-limits.md",
    slug: "worker-and-api-limits",
    title: "Worker and API Limits",
    summary:
      "Operational limits for the Pharos Worker and API: cron budgets, fetch connection caps, polling intervals, cache behavior, and guardrail checks.",
    group: "system",
  },
  {
    source: "classification.md",
    slug: "classification",
    title: "Classification",
    summary:
      "Stablecoin classification methodology for peg currencies, backing models, governance labels, commodity pegs, lifecycle status, and taxonomy pages.",
    group: "methodology",
  },
  {
    source: "listing-policy.md",
    slug: "listing-policy",
    title: "Stablecoin Listing Policy",
    summary:
      "How Pharos admits, classifies, quarantines, delists, and preserves stablecoin records while separating catalog policy from runtime pricing failures.",
    group: "methodology",
  },
  {
    source: "pricing-pipeline.md",
    slug: "pricing-pipeline",
    title: "Pricing Pipeline",
    summary:
      "How Pharos computes stablecoin prices: source consensus, peg-aware validation, fallback enrichment, stale-data handling, and override policy.",
    group: "methodology",
  },
  {
    source: "depeg-detection.md",
    slug: "depeg-detection",
    title: "Depeg Detection",
    summary:
      "Depeg detection methodology covering two-stage confirmation, peg-score inputs, severity bands, event lifecycle, and recovery handling.",
    group: "methodology",
  },
  {
    source: "dews.md",
    slug: "dews",
    title: "DEWS",
    summary:
      "Depeg Early Warning System methodology: DEWS formula, stress sub-signals, bands, downgrade gates, and API response contract.",
    group: "methodology",
  },
  {
    source: "dex-liquidity.md",
    slug: "dex-liquidity",
    title: "DEX Liquidity",
    summary:
      "DEX Liquidity Score methodology for stablecoins: pool discovery, depth scoring, durability, pair diversity, cross-validation, and risk bands.",
    group: "methodology",
  },
  {
    source: "stability-index.md",
    slug: "stability-index",
    title: "Pharos Stability Index",
    summary:
      "Pharos Stability Index methodology explaining the PSI formula, active universe, stress bands, storage model, API surface, and replay rules.",
    group: "methodology",
  },
  {
    source: "report-cards.md",
    slug: "report-cards",
    title: "Report Cards",
    summary:
      "Stablecoin report-card methodology for safety scoring, peg risk, liquidity, reserves, resilience, decentralization, dependency exposure, and portfolios.",
    group: "methodology",
  },
  {
    source: "redemption-backstops.md",
    slug: "redemption-backstops",
    title: "Redemption Backstops",
    summary:
      "Redemption Backstops methodology for exit routes, redemption terms, effective-exit scoring, operational disclosures, and stored review evidence.",
    group: "methodology",
  },
  {
    source: "chain-health.md",
    slug: "chain-health",
    title: "Chain Health",
    summary:
      "Chain Health Score methodology for stablecoin networks: supply concentration, venue health, deployment coverage, risk factors, and score bands.",
    group: "methodology",
  },
  {
    source: "mint-burn-flows.md",
    slug: "mint-burn-flows",
    title: "Mint Burn Flows",
    summary:
      "Mint and burn flow methodology covering issuance-chain ingestion, pressure scoring, Bank Run Gauge inputs, reconciliation, and backfills.",
    group: "methodology",
  },
  {
    source: "yield-intelligence.md",
    slug: "yield-intelligence",
    title: "Yield Intelligence",
    summary:
      "Yield Intelligence methodology for stablecoin APY resolution, Pharos Yield Score, source confidence, reward warnings, and risk-adjusted ranking.",
    group: "methodology",
  },
  {
    source: "shadow-stablecoins.md",
    slug: "shadow-stablecoins",
    title: "Shadow Stablecoins",
    summary:
      "Shadow stablecoin policy for PSI-only assets, eligibility boundaries, UI exclusions, data handling, and why these assets stay out of main rankings.",
    group: "methodology",
  },
  {
    source: "design-context.md",
    slug: "design-context",
    title: "Design Context",
    summary:
      "Pharos design context for product direction, user needs, brand posture, information density, and how the dashboard should feel in daily use.",
    group: "design",
  },
  {
    source: "design-language.md",
    slug: "design-language",
    title: "Design Language",
    summary:
      "Pharos design language reference for live UI patterns, typography, spacing, responsive behavior, visual hierarchy, and route-specific conventions.",
    group: "design",
  },
  {
    source: "design-tokens.md",
    slug: "design-tokens",
    title: "Design Tokens",
    summary:
      "Design token reference for Pharos CSS variables, semantic layers, colors, spacing, component styling, and token ownership rules.",
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

function redactRunbookText(text: string): string {
  return text.replace(/\brunbooks?\b/gi, (match) =>
    match.toLowerCase().endsWith("s") ? "operator procedures" : "operator procedure",
  );
}

function redactPublicDocSource(markdown: string, source?: string): string {
  const withoutRunbookLinks = markdown.replace(
    /\[([^\]]+)\]\((?:\.\/)?runbooks\/[^)]+\)/gi,
    (_full, label: string) => redactRunbookText(label),
  );
  const withoutAgentPaths = redactRunbookText(withoutRunbookLinks)
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
