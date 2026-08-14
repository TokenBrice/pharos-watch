import { parseLiveReserveAdapterParams, type LiveReserveAdapterParamsByKey } from "@shared/lib/live-reserve-adapters";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchIndependentAssuranceReserves,
  type IndependentAssuranceProfile,
} from "./independent-assurance";

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function formatDate(year: number, month: number, day: number): string | null {
  if (
    year < 2000 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate()
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function straitsxReportDate(href: string, text: string): string | null {
  const fileName = decodeURIComponent(new URL(href).pathname.split("/").pop() ?? "");
  const fullDate = fileName.match(
    /(\d{1,2})[ _-](Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[ _-]((?:19|20)\d{2})/i,
  );
  if (fullDate) {
    return formatDate(Number(fullDate[3]), MONTHS[fullDate[2].toLowerCase()], Number(fullDate[1]));
  }

  const compactDate = fileName.match(/(?:xsgd|xusd)-(\d{2})(\d{2})(\d{2})(?:\D|$)/i);
  if (compactDate) {
    return formatDate(2000 + Number(compactDate[1]), Number(compactDate[2]), Number(compactDate[3]));
  }

  const monthOnly = fileName.match(/(?:xsgd|xusd)-report-(\d{2}|(?:19|20)\d{2})-([a-z]+)/i);
  if (monthOnly) {
    const month = MONTHS[monthOnly[2].toLowerCase()];
    const year = monthOnly[1].length === 2 ? 2000 + Number(monthOnly[1]) : Number(monthOnly[1]);
    if (month) return formatDate(year, month, new Date(Date.UTC(year, month, 0)).getUTCDate());
  }

  const labelDate = text.match(
    /\b(Mid-)?(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+((?:19|20)\d{2})\b/i,
  );
  if (!labelDate) return null;
  const month = MONTHS[labelDate[2].toLowerCase()];
  const year = Number(labelDate[3]);
  return formatDate(year, month, labelDate[1] ? 15 : new Date(Date.UTC(year, month, 0)).getUTCDate());
}

const STRAITSX_PROFILE_BASE: Omit<
  IndependentAssuranceProfile,
  "product" | "requiredAssetCodes" | "isReportCandidate" | "reportDateFromCandidate"
> = {
  adapterName: "straitsx-independent-assurance",
  profile: "straitsx-v1",
  classifications: {
    cash: {
      name: "Cash deposits in the safeguarded reserve account",
      risk: "very-low",
      assetClass: "cash",
      issuerOrObligor: "Undisclosed MAS-permitted safeguarding institution",
      riskFactors: ["counterparty", "custody", "concentration"],
      liquidityHorizon: "immediate",
    },
    "short-dated-government-or-repo": {
      name: "Short-dated sovereign instruments or eligible overnight reverse repos",
      risk: "very-low",
      assetClass: "other",
      issuerOrObligor: "Relevant government or eligible highly rated overnight reverse-repo counterparty",
      riskFactors: ["counterparty", "duration", "liquidity", "custody"],
      liquidityHorizon: "unknown",
    },
    "fixed-deposits": {
      name: "Fixed deposits",
      risk: "very-low",
      assetClass: "bank-deposit",
      issuerOrObligor: "Undisclosed safeguarding institution",
      riskFactors: ["counterparty", "custody", "liquidity"],
      liquidityHorizon: "unknown",
    },
  },
};

export function straitsxIndependentAssuranceProfile(product: "XSGD" | "XUSD"): IndependentAssuranceProfile {
  return {
    ...STRAITSX_PROFILE_BASE,
    product,
    requiredAssetCodes: product === "XSGD" ? ["cash", "short-dated-government-or-repo"] : ["cash"],
    isReportCandidate: (href, text) => {
      const decoded = decodeURIComponent(`${href} ${text}`);
      return !/whitepaper/i.test(decoded) && decoded.toUpperCase().includes(product) &&
        /(?:SCS[ _]Reserve[ _]Account[ _]Report|Attestation Report)/i.test(decoded);
    },
    reportDateFromCandidate: straitsxReportDate,
  };
}

export async function fetchStraitsxIndependentAssuranceReserves(
  coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const params = parseLiveReserveAdapterParams("straitsx-independent-assurance", config.params) as
    LiveReserveAdapterParamsByKey["straitsx-independent-assurance"];
  return fetchIndependentAssuranceReserves(
    coin,
    config,
    signal,
    straitsxIndependentAssuranceProfile(params.product),
    params,
    ctx,
  );
}
