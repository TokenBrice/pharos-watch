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

function paxosReportDate(product: PaxosProduct, href: string): string | null {
  const manifest = getIndependentAssuranceManifest(product);
  return href === manifest.reportUrl ? manifest.reportDate : null;
}

// Website pins reverified 2026-09-28 after another Framer redeploy changed
// every module bundle hash; each product module still lists its reviewed
// report. PAXG/PYUSD/USDP keep the August 31 KPMG reports admitted 2026-09-25.
// USDG keeps its reviewed July 31 report; its newly listed August report is
// not admitted. Only reviewed products are registered; absent products fail
// closed.
const PAXOS_PRODUCTS: Partial<Record<PaxosProduct, { pin: PaxosDiscoveryPin; profile: IndependentAssuranceProfile }>> = {
  PAXG: {
    // Reviewed 2026-09-25: official route and August 31 KPMG report selection
    // (Exhibit A adds a 5-token Robinhood column beside Ethereum and Solana).
    pin: {
      mainUrl: "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl/script_main.CU-BUxan.mjs",
      mainSha256: "37179ea3a17093734729f8078448dd4ab7313d5053f8418d6b0039dab0c48030",
      pageUrl: "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl/9XsTDCj88fcSkvOKlIugorJnpRlJ-sQBU3zcghHZAGU.DQbrTS7f.mjs",
      pageSha256: "904ad6c96c851d1a601432ba6f50f7a3e56e1f4002d56eb0f69b05836cff20d5",
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
    pin: {
      mainUrl: "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl/script_main.CU-BUxan.mjs",
      mainSha256: "37179ea3a17093734729f8078448dd4ab7313d5053f8418d6b0039dab0c48030",
      pageUrl: "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl/gaXXeRLPJVU8xNh11dsVtC1bnIYsH9HFFZN3Q7yy4xM.se44MCDY.mjs",
      pageSha256: "24f08be1e5248a4112cd44408981fbee6f13ece74890cc87d47b6f2e3767ae5b",
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
    // Reviewed 2026-09-09: July 2026 y397A2bek / MyKpGtOFv / LghKhDIKj
    // override selects IJR7..., not the base July U6Cd... report. Pins
    // reverified 2026-09-28; the newly listed August Xn1U... report (as of
    // August 6 and 31) is not yet reviewed, so July stays selected.
    pin: {
      mainUrl: "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl/script_main.CU-BUxan.mjs",
      mainSha256: "37179ea3a17093734729f8078448dd4ab7313d5053f8418d6b0039dab0c48030",
      pageUrl: "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl/Dpx7vvLtZ0_GXJdsd7UXSGLBYctWInqJeDbtf1NUTGo.CwgpI-_s.mjs",
      pageSha256: "c1ed4f8ca146cfe5f5db877ba8f938a41144704a0fdd01d511a11580ec5b1a1e",
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
    pin: {
      mainUrl: "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl/script_main.CU-BUxan.mjs",
      mainSha256: "37179ea3a17093734729f8078448dd4ab7313d5053f8418d6b0039dab0c48030",
      pageUrl: "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl/T6xLeGdnaKeagfQVSfjAmjg0_UAsdgPLW9gmBy9jinM.D9Z8ihGD.mjs",
      pageSha256: "8551ec0bcf25e4faa0566c4e598bc85d5151e93969286557a75957b79cf8d941",
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
