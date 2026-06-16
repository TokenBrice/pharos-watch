import type { PriceObservedAtMode, StablecoinMeta } from "@shared/types/core";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import type { PriceValidationReferences } from "../price-validation";
import {
  normalizeHistoricalTimestamps,
  PROTOCOL_REDEEM_SOURCE,
  type CurrentPriceOverride,
  type HistoricalPriceContext,
  type HistoricalPricePoint,
  type LivePriceContext,
  type PriceSourceProvider,
} from "./helpers";

const SOFID_SOFI_ID = "sofid-sofi";
const CHFAU_ALLUNITY_ID = "chfau-allunity";
const USBD_BIMA_ID = "usbd-bima";
const USDQ_QUILL_ID = "usdq-quill";
const CADD_CAD_DIGITAL_ID = "cadd-cad-digital";
const JPYM_MENTO_ID = "jpym-mento";
const ZARM_MENTO_ID = "zarm-mento";
const XOFM_MENTO_ID = "xofm-mento";

interface ProtocolParConfig {
  id: string;
  pegType: "peggedUSD" | "peggedCHF" | "peggedCAD" | "peggedJPY" | "peggedZAR" | "peggedXOF";
}

const PROTOCOL_PAR_PRICE_CONFIGS: readonly ProtocolParConfig[] = [
  { id: SOFID_SOFI_ID, pegType: "peggedUSD" },
  { id: USBD_BIMA_ID, pegType: "peggedUSD" },
  { id: USDQ_QUILL_ID, pegType: "peggedUSD" },
  { id: CHFAU_ALLUNITY_ID, pegType: "peggedCHF" },
  { id: CADD_CAD_DIGITAL_ID, pegType: "peggedCAD" },
  { id: JPYM_MENTO_ID, pegType: "peggedJPY" },
  { id: ZARM_MENTO_ID, pegType: "peggedZAR" },
  { id: XOFM_MENTO_ID, pegType: "peggedXOF" },
];

const PROTOCOL_PAR_PRICE_CONFIGS_BY_ID = new Map<string, ProtocolParConfig>(
  PROTOCOL_PAR_PRICE_CONFIGS.map((entry) => [entry.id, entry]),
);

function getReferenceType(
  references: PriceValidationReferences | undefined,
  pegType: string,
): PriceValidationReferences["type"] {
  return references?.typeByPeg?.[pegType] ?? references?.type ?? "none";
}

function getProtocolParPrice(
  config: ProtocolParConfig,
  references: PriceValidationReferences | undefined,
): { price: number; observedAt: number | null; observedAtMode: PriceObservedAtMode } | null {
  if (config.pegType === "peggedUSD") {
    return {
      price: 1,
      observedAt: null,
      observedAtMode: "local_fetch",
    };
  }

  const referenceType = getReferenceType(references, config.pegType);
  if (referenceType !== "fresh" && referenceType !== "static") return null;

  const rate = references?.rates[config.pegType];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;

  return {
    price: rate,
    observedAt: references?.updatedAtByPeg?.[config.pegType] ?? references?.updatedAt ?? null,
    observedAtMode: referenceType === "fresh" ? "upstream" : "local_fetch",
  };
}

export const protocolParProvider: PriceSourceProvider = {
  source: PROTOCOL_REDEEM_SOURCE,
  matches(stablecoinId: string): boolean {
    return PROTOCOL_PAR_PRICE_CONFIGS_BY_ID.has(stablecoinId);
  },
  matchesHistoricalPrices(stablecoinId: string): boolean {
    return PROTOCOL_PAR_PRICE_CONFIGS_BY_ID.get(stablecoinId)?.pegType === "peggedUSD";
  },
  async fetchLivePrice(
    asset: PeggedAsset,
    context: LivePriceContext,
  ): Promise<CurrentPriceOverride | null> {
    const config = PROTOCOL_PAR_PRICE_CONFIGS_BY_ID.get(asset.id);
    if (!config) return null;

    const resolved = getProtocolParPrice(config, context.validationReferences);
    if (!resolved) return null;

    return {
      price: resolved.price,
      source: PROTOCOL_REDEEM_SOURCE,
      confidence: "high",
      observedAt: resolved.observedAt,
      observedAtMode: resolved.observedAtMode,
    };
  },
  async fetchHistoricalPrices(
    meta: StablecoinMeta,
    context: HistoricalPriceContext,
  ): Promise<HistoricalPricePoint[] | null> {
    const config = PROTOCOL_PAR_PRICE_CONFIGS_BY_ID.get(meta.id);
    if (!config || config.pegType !== "peggedUSD") return null;

    const timestamps = normalizeHistoricalTimestamps(context.candidateTimestamps);
    return timestamps.map((timestamp) => ({ timestamp, price: 1 }));
  },
};
