import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import { fetchIndependentAssuranceReserves, type IndependentAssuranceProfile } from "./independent-assurance";
import type { AdapterContext, AdapterResult } from "./types";
import { formatValidIsoDate, lastDayOfMonth, monthNumberFromLabel } from "./report-date";

// CAD Digital publishes Baker Tilly WM LLP's monthly CSAE 3000 reasonable
// assurance reports on https://tetradg.com/cadd-reserve-attestations/ as
// Google Drive share links (`drive.google.com/file/d/<id>/view?usp=sharing`).
// Drive share URLs carry no report date, so discovery dates each candidate
// from its anchor text ("June 2026 attestation" -> 2026-06-30) and
// prepareIndexHtml rewrites the share links to direct-download URLs
// (`drive.google.com/uc?export=download&id=<id>`) that the PDF verifier can
// fetch on the pinned `drive.google.com` / `drive.usercontent.google.com`
// hosts. The shared verifier still requires the newest dated candidate to be
// the reviewed manifest report; a newer unreviewed attestation on the index
// fails closed.

const CADD_DRIVE_VIEW_LINK =
  /https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)\/view\?usp=sharing/g;

async function prepareCaddIndexHtml(html: string): Promise<string> {
  return html.replace(
    CADD_DRIVE_VIEW_LINK,
    (_match, id: string) =>
      `https://drive.google.com/uc?export=download&id=${id}&name=attestation.pdf`,
  );
}

function caddReportDate(_href: string, text: string): string | null {
  const match = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+((?:19|20)\d{2})\s+attestation\b/i,
  );
  if (!match) return null;
  const month = monthNumberFromLabel(match[1]);
  const year = Number(match[2]);
  if (!month) return null;
  return formatValidIsoDate(year, month, lastDayOfMonth(year, month)!);
}

export const CADD_INDEPENDENT_ASSURANCE_PROFILE: IndependentAssuranceProfile = {
  adapterName: "cadd-independent-assurance",
  product: "CADD",
  profile: "cadd-v1",
  requiredAssetCodes: ["cad-cash"],
  classifications: {
    "cad-cash": {
      name: "Canadian Dollar Cash",
      risk: "very-low",
      assetClass: "cash",
      issuerOrObligor:
        "Canadian dollar demand deposits held in segregated Tetra Trust trust accounts at Canadian financial institutions",
      riskFactors: ["counterparty", "custody", "concentration"],
      liquidityHorizon: "immediate",
    },
  },
  isReportCandidate: (_href, text) => /attestation/i.test(text),
  reportDateFromCandidate: caddReportDate,
  prepareIndexHtml: prepareCaddIndexHtml,
};

export async function fetchCaddIndependentAssuranceReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = parseLiveReserveAdapterParams("cadd-independent-assurance", config.params) as
    LiveReserveAdapterParamsByKey["cadd-independent-assurance"];
  return fetchIndependentAssuranceReserves(coin, config, signal, CADD_INDEPENDENT_ASSURANCE_PROFILE, params, ctx);
}
