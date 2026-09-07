import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { getIndependentAssuranceManifest } from "@shared/lib/independent-assurance";
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

// Pharos reserve research, 2026-09-07: the official /paxg-transparency HTML
// loads this main module, whose exact route imports this PAXG page module.
// Reviewed its 2026 July button against the KPMG July 31 report in the manifest.
// Any website-module change requires review, including unrelated Framer deploys.
const PAXG_DISCOVERY: PaxosDiscoveryPin = {
  mainUrl: "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl/script_main.DbHh1PDb.mjs",
  mainSha256: "75246095328cd57d84ba6056ca26adcef441670acb707fbf6c58c2397c8af29d",
  pageUrl: "https://framerusercontent.com/sites/3XxgTiMfDKU2yZKNfef9sl/9XsTDCj88fcSkvOKlIugorJnpRlJ-sQBU3zcghHZAGU.D0DGZcue.mjs",
  pageSha256: "0ce7ca8b17db4c631afb861531f8c467f45926a4f012f5508ba2d513d1ddb68f",
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

const PROFILE: IndependentAssuranceProfile = {
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
  prepareIndexHtml: async (html, signal, ctx) => {
    const page = await verifyPaxosDiscovery(html, PAXG_DISCOVERY, signal, ctx);
    const manifest = getIndependentAssuranceManifest("PAXG");
    if (!page.includes(`file:\`${manifest.reportUrl}\``)) {
      throw new Error("paxos-independent-assurance: reviewed report missing from product module");
    }
    return `<a href="${manifest.reportUrl}">PAXG report ${manifest.reportDate}</a>`;
  },
};

export function fetchPaxosIndependentAssuranceReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
) {
  return fetchIndependentAssuranceReserves(coin, config, signal, PROFILE, {
    product: "PAXG",
    profile: "paxg-v1",
    indexHost: "www.paxos.com",
    reportHosts: ["framerusercontent.com"],
  }, ctx);
}
