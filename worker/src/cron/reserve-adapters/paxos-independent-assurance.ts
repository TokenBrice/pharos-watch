import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { getIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { sha256Hex } from "../../lib/hash";
import { fetchIndependentAssuranceReserves, type IndependentAssuranceProfile } from "./independent-assurance";
import { readHtmlAttribute } from "./helpers";
import { fetchTextResponseWithRetry } from "./request";
import type { AdapterContext } from "./types";

export interface PaxosDiscoveryPin {
  mainUrl: string;
  mainSha256: string;
  pageUrl: string;
  pageSha256: string;
}

type PaxosProduct = LiveReserveAdapterParamsByKey["paxos-independent-assurance"]["product"];

// Only reviewed products are registered; absent products fail closed.
const PAXOS_PRODUCTS: Partial<Record<PaxosProduct, { pin: PaxosDiscoveryPin; profile: IndependentAssuranceProfile }>> = {
  PAXG: {
    // Reviewed 2026-09-07: official route and July 31 KPMG report selection.
    pin: {
      mainUrl: "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl/script_main.B7a0dxmx.mjs",
      mainSha256: "e8b6c9dba2b15785dd42d92867b44168d63a3c1bb80820a1170f06147c971123",
      pageUrl: "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl/9XsTDCj88fcSkvOKlIugorJnpRlJ-sQBU3zcghHZAGU.CzE_V_39.mjs",
      pageSha256: "c98a74ad172b430181fbc644a0620a5e4f35c8a2ac2b3088f32b15ea6ee79d5b",
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
    },
  },
  PYUSD: {
    // Reviewed July 2026 year-specific open variants on 2026-09-09.
    pin: {
      mainUrl: "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl/script_main.B7a0dxmx.mjs",
      mainSha256: "e8b6c9dba2b15785dd42d92867b44168d63a3c1bb80820a1170f06147c971123",
      pageUrl: "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl/gaXXeRLPJVU8xNh11dsVtC1bnIYsH9HFFZN3Q7yy4xM.UP0ye98M.mjs",
      pageSha256: "d5241c765a5f354d101eb4b8600281f2941ae6f8794608403355556bef58f628",
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
    },
  },
  USDG: {
    // Reviewed 2026-09-09: July 2026 y397A2bek / MyKpGtOFv / LghKhDIKj
    // override selects IJR7..., not the base July U6Cd... report.
    pin: {
      mainUrl: "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl/script_main.B7a0dxmx.mjs",
      mainSha256: "e8b6c9dba2b15785dd42d92867b44168d63a3c1bb80820a1170f06147c971123",
      pageUrl: "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl/Dpx7vvLtZ0_GXJdsd7UXSGLBYctWInqJeDbtf1NUTGo.1MVkauuJ.mjs",
      pageSha256: "08f400c4894e241d899a1642879b661be9f75f3d8753b63e3ddc69d5dd20add9",
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
    },
  },
  USDP: {
    // Reviewed July 2026 year-specific open variants on 2026-09-09.
    pin: {
      mainUrl: "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl/script_main.B7a0dxmx.mjs",
      mainSha256: "e8b6c9dba2b15785dd42d92867b44168d63a3c1bb80820a1170f06147c971123",
      pageUrl: "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl/T6xLeGdnaKeagfQVSfjAmjg0_UAsdgPLW9gmBy9jinM.BO5TmawR.mjs",
      pageSha256: "8ec23599bcf7a12a31245f613a44e61b82149550207aae95d25a18e4d99aaf08",
    },
    profile: {
      adapterName: "paxos-independent-assurance", product: "USDP", profile: "usdp-v1",
      requiredAssetCodes: ["cash", "reverse-repo"],
      classifications: {
        cash: { name: "USD bank deposits held for token holders", risk: "very-low", assetClass: "bank-deposit", issuerOrObligor: "Undisclosed United States commercial banks", riskFactors: ["counterparty", "custody", "liquidity", "concentration"], liquidityHorizon: "immediate" },
        "reverse-repo": { name: "Overnight U.S. Treasury reverse repurchase agreements", risk: "very-low", assetClass: "repo", issuerOrObligor: "Undisclosed United States banks; U.S. Treasury collateral", riskFactors: ["counterparty", "custody", "liquidity"], liquidityHorizon: "one-day" },
      },
      isReportCandidate: (href) => href === getIndependentAssuranceManifest("USDP").reportUrl,
    },
  },
};

export async function verifyPaxosDiscovery(
  html: string,
  pin: PaxosDiscoveryPin,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<string> {
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)]
    .map(([tag]) => readHtmlAttribute(tag, "src"))
    .filter((src) => src?.includes("script_main."));
  if (scripts.length !== 1 || scripts[0] !== pin.mainUrl) {
    throw new Error("paxos-independent-assurance: official index has changed or ambiguous main module");
  }
  let page = "";
  for (const [url, expectedHash] of [[pin.mainUrl, pin.mainSha256], [pin.pageUrl, pin.pageSha256]]) {
    const response = await fetchTextResponseWithRetry(url!, signal, 10_000, ctx, {
      maxRetries: 0,
      maxResponseBytes: 1024 * 1024,
    });
    if (response.finalUrl !== url) {
      throw new Error("paxos-independent-assurance: module response URL drifted");
    }
    const hash = await sha256Hex(response.body);
    // eslint-disable-next-line security/detect-possible-timing-attacks -- public website integrity pins are not secrets.
    if (hash !== expectedHash) {
      throw new Error("paxos-independent-assurance: website module changed; review report selection before publication");
    }
    page = response.body;
  }
  return page;
}


export async function fetchPaxosIndependentAssuranceReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
) {
  const { product } = parseLiveReserveAdapterParams("paxos-independent-assurance", config.params);
  const entry = PAXOS_PRODUCTS[product];
  if (!entry) throw new Error(`paxos-independent-assurance: no reviewed discovery/profile for ${product}`);
  const manifest = getIndependentAssuranceManifest(product);
  const profile: IndependentAssuranceProfile = {
    ...entry.profile,
    prepareIndexHtml: async (html, requestSignal, context) => {
      const page = await verifyPaxosDiscovery(html, entry.pin, requestSignal, context);
      if (!page.includes(`file:\`${manifest.reportUrl}\``)) {
        throw new Error("paxos-independent-assurance: reviewed report missing from product module");
      }
      return `<a href="${manifest.reportUrl}">${product} report ${manifest.reportDate}</a>`;
    },
  };
  return fetchIndependentAssuranceReserves(coin, config, signal, profile, {
    product,
    profile: profile.profile,
    indexHost: new URL(manifest.officialIndexUrl).hostname,
    reportHosts: [new URL(entry.pin.pageUrl).hostname],
  }, ctx);
}
