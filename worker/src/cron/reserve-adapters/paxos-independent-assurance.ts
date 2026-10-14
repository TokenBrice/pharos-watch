import type { ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { getIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { fetchIndependentAssuranceReserves } from "./independent-assurance";
import { readHtmlAttribute } from "./helpers";
import { fetchTextResponseWithRetry } from "./request";
import type { AdapterContext, IndependentAssuranceProfile } from "./types";

type PaxosProduct = LiveReserveAdapterParamsByKey["paxos-independent-assurance"]["product"];

/**
 * Machine-readable discovery failure codes. Every rejection is fail-closed: the
 * adapter never falls back to a stale module, an unreviewed selection, or a
 * partially parsed route table.
 */
export type PaxosDiscoveryFailureCode =
  | "main-module-missing"
  | "main-module-ambiguous"
  | "main-module-origin-drifted"
  | "main-module-response-drifted"
  | "route-table-unrecognized"
  | "route-binding-missing"
  | "route-binding-ambiguous"
  | "page-module-identity-drifted"
  | "page-module-response-drifted"
  | "report-binding-missing";

export class PaxosDiscoveryError extends Error {
  readonly code: PaxosDiscoveryFailureCode;

  constructor(code: PaxosDiscoveryFailureCode, detail: string) {
    super(`paxos-independent-assurance: ${code}: ${detail}`);
    this.name = "PaxosDiscoveryError";
    this.code = code;
  }
}

/**
 * Durable per-product binding. Framer redeploys rename the hashed main-module
 * and chunk filenames on every publish (five renames between September 30 and
 * October 14, 2026 alone), so those filenames are never pinned. The pinned
 * identities are the ones that survive redeploys: the reviewed Framer site
 * origin, the official route path, and the product page module's stable
 * content identity, which changes only when Paxos re-publishes the page
 * itself — exactly the event (typically a newer report) that must force
 * review. The reviewed report PDF stays pinned by the manifest's byte-length
 * and SHA-256 through the shared verifier.
 */
export interface PaxosProductBinding {
  /** Reviewed Framer site origin serving the main and page modules. */
  siteOrigin: string;
  /** Official route the index page is served at, e.g. `/pyusd-transparency`. */
  routePath: string;
  /** Stable content identity of the reviewed product page module. */
  pageModuleId: string;
}

function paxosReportDate(product: PaxosProduct, href: string): string | null {
  const manifest = getIndependentAssuranceManifest(product);
  return href === manifest.reportUrl ? manifest.reportDate : null;
}

const PAXOS_FRAMER_SITE_ORIGIN = "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl";

// Page-module identities reverified 2026-10-14 against the DWSgnPFN redeploy:
// all four route tables still bind the reviewed page modules, whose bytes still
// match the reviewed October 13 SHA-256 captures and still bind the reviewed
// August 31 reports. Only hashed chunk filenames changed.
// Only reviewed products are registered; absent products fail closed.
const PAXOS_PRODUCTS: Partial<Record<PaxosProduct, { binding: PaxosProductBinding; profile: IndependentAssuranceProfile }>> = {
  PAXG: {
    // Reviewed 2026-09-25: official route and August 31 KPMG report selection
    // (Exhibit A adds a 5-token Robinhood column beside Ethereum and Solana).
    binding: {
      siteOrigin: PAXOS_FRAMER_SITE_ORIGIN,
      routePath: "/paxg-transparency",
      pageModuleId: "9XsTDCj88fcSkvOKlIugorJnpRlJ-sQBU3zcghHZAGU",
    },
    profile: {
      adapterName: "paxos-independent-assurance",
      product: "PAXG",
      profile: "paxg-v1",
      requiredAssetCodes: ["allocated-gold"],
      classifications: {
        "allocated-gold": {
          name: "Physical gold bars (London Good Delivery, LBMA-accredited London vaults)",
          risk: "very-low",
          assetClass: "commodity-allocated",
          issuerOrObligor: "Paxos Trust Company, N.A. and allocated gold held in LBMA-accredited London vaults",
          riskFactors: ["custody", "legal", "liquidity", "market", "concentration"],
          liquidityHorizon: "unknown",
        },
      },
      isReportCandidate: (href) => href === getIndependentAssuranceManifest("PAXG").reportUrl,
      reportDateFromCandidate: (href) => paxosReportDate("PAXG", href),
    },
  },
  PYUSD: {
    // Reviewed August 2026 year-specific open variants on 2026-09-25.
    binding: {
      siteOrigin: PAXOS_FRAMER_SITE_ORIGIN,
      routePath: "/pyusd-transparency",
      pageModuleId: "gaXXeRLPJVU8xNh11dsVtC1bnIYsH9HFFZN3Q7yy4xM",
    },
    profile: {
      adapterName: "paxos-independent-assurance", product: "PYUSD", profile: "pyusd-v1",
      requiredAssetCodes: ["cash", "reverse-repo", "treasury-bills"],
      classifications: {
        cash: { name: "USD bank deposits held for token holders", risk: "very-low", assetClass: "bank-deposit", issuerOrObligor: "Undisclosed United States commercial banks", riskFactors: ["counterparty", "custody", "liquidity", "concentration"], liquidityHorizon: "immediate" },
        "reverse-repo": { name: "Overnight U.S. Treasury reverse repurchase agreements", risk: "very-low", assetClass: "repo", issuerOrObligor: "Undisclosed United States banks; U.S. Treasury collateral", riskFactors: ["counterparty", "custody", "liquidity"], liquidityHorizon: "one-day" },
        "treasury-bills": { name: "U.S. Treasury bills (remaining maturity at most three months)", risk: "very-low", assetClass: "treasury-bill", issuerOrObligor: "United States Treasury", riskFactors: ["duration", "market", "custody"], liquidityHorizon: "over-seven-days" },
      },
      isReportCandidate: (href) => href === getIndependentAssuranceManifest("PYUSD").reportUrl,
      reportDateFromCandidate: (href) => paxosReportDate("PYUSD", href),
    },
  },
  USDG: {
    // Reviewed 2026-09-30: August 2026 y397A2bek / MyKpGtOFv / LghKhDIKj
    // overrides all select Xn1U..., examined August 6 and 31, signed September 25.
    binding: {
      siteOrigin: PAXOS_FRAMER_SITE_ORIGIN,
      routePath: "/usdg-transparency",
      pageModuleId: "Dpx7vvLtZ0_GXJdsd7UXSGLBYctWInqJeDbtf1NUTGo",
    },
    profile: {
      adapterName: "paxos-independent-assurance", product: "USDG", profile: "usdg-v1",
      requiredAssetCodes: ["cash", "government-mmf", "treasury-bills"],
      classifications: {
        cash: { name: "USD bank deposits (PDS Singapore and PIE Luxembourg)", risk: "very-low", assetClass: "bank-deposit", issuerOrObligor: "Undisclosed Singapore and Luxembourg commercial banks", riskFactors: ["counterparty", "custody", "liquidity", "concentration"], liquidityHorizon: "immediate" },
        "government-mmf": { name: "Government money market funds (PDS and PIE)", risk: "very-low", assetClass: "money-market-fund", issuerOrObligor: "Government money market funds holding U.S. government obligations and reverse repos", riskFactors: ["counterparty", "custody", "liquidity"], liquidityHorizon: "one-day" },
        "treasury-bills": { name: "U.S. Treasury bills (remaining maturity at most three months)", risk: "very-low", assetClass: "treasury-bill", issuerOrObligor: "United States Treasury", riskFactors: ["duration", "market", "custody"], liquidityHorizon: "over-seven-days" },
      },
      isReportCandidate: (href) => href === getIndependentAssuranceManifest("USDG").reportUrl,
      reportDateFromCandidate: (href) => paxosReportDate("USDG", href),
    },
  },
  USDP: {
    // Reviewed August 2026 year-specific open variants on 2026-09-25.
    binding: {
      siteOrigin: PAXOS_FRAMER_SITE_ORIGIN,
      routePath: "/usdp-transparency",
      pageModuleId: "T6xLeGdnaKeagfQVSfjAmjg0_UAsdgPLW9gmBy9jinM",
    },
    profile: {
      adapterName: "paxos-independent-assurance", product: "USDP", profile: "usdp-v1",
      requiredAssetCodes: ["cash", "reverse-repo"],
      classifications: {
        cash: { name: "USD bank deposits held for token holders", risk: "very-low", assetClass: "bank-deposit", issuerOrObligor: "Undisclosed United States commercial banks", riskFactors: ["counterparty", "custody", "liquidity", "concentration"], liquidityHorizon: "immediate" },
        "reverse-repo": { name: "Overnight U.S. Treasury reverse repurchase agreements", risk: "very-low", assetClass: "repo", issuerOrObligor: "Undisclosed United States banks; U.S. Treasury collateral", riskFactors: ["counterparty", "custody", "liquidity"], liquidityHorizon: "one-day" },
      },
      isReportCandidate: (href) => href === getIndependentAssuranceManifest("USDP").reportUrl,
      reportDateFromCandidate: (href) => paxosReportDate("USDP", href),
    },
  },
};

/** Framer route entry: `page:L(()=>import(`./<id>.<chunk>.mjs`)),path:`/route``. */
const ROUTE_ENTRY_PATTERN = /import\(`(\.\/[A-Za-z0-9_.-]+\.mjs)`\)[^{}]*path:`([^`]+)`/g;
const ROUTE_PATH_PATTERN = /path:`([^`]+)`/g;
const PAGE_MODULE_SPECIFIER_PATTERN = /^\.\/([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.mjs$/;

/**
 * Resolve the reviewed product page module from the served index HTML without
 * executing any website JavaScript. Chain: the index must reference exactly one
 * `script_main` module, served by the reviewed Framer site origin; that main
 * module's route table must bind the official route to exactly one page-module
 * import; the import must carry the reviewed page-module identity; and the
 * resolved page module must bind the reviewed report PDF. Returns the page
 * module text so callers can surface the verified selection.
 */
export async function verifyPaxosDiscovery(
  html: string,
  binding: PaxosProductBinding,
  reportUrl: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<string> {
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)]
    .map(([tag]) => readHtmlAttribute(tag, "src"))
    .filter((src) => src?.includes("script_main."));
  if (scripts.length === 0) {
    throw new PaxosDiscoveryError("main-module-missing", "official index references no script_main module");
  }
  if (scripts.length > 1) {
    throw new PaxosDiscoveryError(
      "main-module-ambiguous",
      `official index references ${scripts.length} script_main modules: ${[...new Set(scripts)].join(", ")}`,
    );
  }
  let mainUrl: URL;
  try {
    mainUrl = new URL(scripts[0]!);
  } catch {
    throw new PaxosDiscoveryError("main-module-origin-drifted", `script src ${scripts[0]} is not a valid absolute URL`);
  }
  if (mainUrl.origin !== new URL(binding.siteOrigin).origin) {
    throw new PaxosDiscoveryError(
      "main-module-origin-drifted",
      `main module ${mainUrl.href} is not served by the reviewed site ${binding.siteOrigin}`,
    );
  }

  const mainResponse = await fetchTextResponseWithRetry(mainUrl.href, signal, 10_000, ctx, {
    maxRetries: 0,
    maxResponseBytes: 1024 * 1024,
  });
  if (mainResponse.finalUrl !== mainUrl.href) {
    throw new PaxosDiscoveryError("main-module-response-drifted", `main module redirected to ${mainResponse.finalUrl}`);
  }

  // The route table is trusted only when every route entry binds a page import;
  // a partially recognizable table fails closed instead of trusting one binding.
  const routeEntries = [...mainResponse.body.matchAll(ROUTE_ENTRY_PATTERN)];
  const routePathCount = [...mainResponse.body.matchAll(ROUTE_PATH_PATTERN)].length;
  if (routeEntries.length !== routePathCount) {
    throw new PaxosDiscoveryError(
      "route-table-unrecognized",
      `main module binds ${routeEntries.length} of ${routePathCount} route entries to page imports`,
    );
  }
  const forRoute = routeEntries.filter(([, , route]) => route === binding.routePath);
  if (forRoute.length === 0) {
    throw new PaxosDiscoveryError(
      "route-binding-missing",
      `official route ${binding.routePath} is absent from the main module route table`,
    );
  }
  if (forRoute.length > 1) {
    throw new PaxosDiscoveryError(
      "route-binding-ambiguous",
      `official route ${binding.routePath} resolves to ${forRoute.length} page modules`,
    );
  }
  const specifier = forRoute[0]![1];
  const pageModuleMatch = PAGE_MODULE_SPECIFIER_PATTERN.exec(specifier);
  if (!pageModuleMatch) {
    throw new PaxosDiscoveryError(
      "route-table-unrecognized",
      `page import ${specifier} for ${binding.routePath} does not use the reviewed identity.chunk shape`,
    );
  }
  if (pageModuleMatch[1] !== binding.pageModuleId) {
    throw new PaxosDiscoveryError(
      "page-module-identity-drifted",
      `route ${binding.routePath} now serves ${pageModuleMatch[1]}.${pageModuleMatch[2]}.mjs; the reviewed page module ${binding.pageModuleId} was re-published, so review the new report selection`,
    );
  }

  const pageModuleUrl = new URL(specifier, mainUrl).href;
  const pageResponse = await fetchTextResponseWithRetry(pageModuleUrl, signal, 10_000, ctx, {
    maxRetries: 0,
    // Product page modules embed the full month archive across locales and run
    // 250-670 KB today (USDP is the largest), so cap above that headroom.
    maxResponseBytes: 2 * 1024 * 1024,
  });
  if (pageResponse.finalUrl !== pageModuleUrl) {
    throw new PaxosDiscoveryError("page-module-response-drifted", `page module redirected to ${pageResponse.finalUrl}`);
  }
  if (!pageResponse.body.includes(`file:\`${reportUrl}\``)) {
    throw new PaxosDiscoveryError(
      "report-binding-missing",
      `reviewed report ${reportUrl} is not bound by page module ${pageModuleMatch[1]}.${pageModuleMatch[2]}.mjs`,
    );
  }
  return pageResponse.body;
}


export async function fetchPaxosIndependentAssuranceReserves(
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
) {
  const { product } = parseLiveReserveAdapterParams("paxos-independent-assurance", config.params);
  const entry = PAXOS_PRODUCTS[product];
  if (!entry) throw new Error(`paxos-independent-assurance: no reviewed discovery/profile for ${product}`);
  const manifest = getIndependentAssuranceManifest(product);
  if (new URL(manifest.officialIndexUrl).pathname !== entry.binding.routePath) {
    throw new Error(
      `paxos-independent-assurance: manifest index ${manifest.officialIndexUrl} does not match reviewed route ${entry.binding.routePath}`,
    );
  }
  const profile: IndependentAssuranceProfile = {
    ...entry.profile,
    prepareIndexHtml: async (html, requestSignal, context) => {
      await verifyPaxosDiscovery(html, entry.binding, manifest.reportUrl, requestSignal, context);
      return `<a href="${manifest.reportUrl}">${product} report ${manifest.reportDate}</a>`;
    },
  };
  return fetchIndependentAssuranceReserves(coin, config, signal, profile, {
    product,
    profile: profile.profile,
    indexHost: new URL(manifest.officialIndexUrl).hostname,
    reportHosts: [new URL(entry.binding.siteOrigin).hostname],
  }, ctx);
}
