import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import type { PriceValidationReferences } from "../price-validation";
import type {
  CurrentPriceOverride,
  HistoricalPricePoint,
  LivePriceContext,
  PriceSourceProvider,
} from "./helpers";

/**
 * Registry key for the nominal par reference (DEC-02 / CR-43). Par is a reviewed
 * constant, not a runtime redemption read: overrides carry no observation clock,
 * no confidence and `observedAtMode: "nominal_reference"`, and the sync decides
 * whether a trusted market quote takes precedence over it.
 */
const PROTOCOL_PAR_SOURCE = "protocol-par";

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
): number | null {
  if (config.pegType === "peggedUSD") return 1;

  // Non-USD par is only expressible in USD through a usable FX reference; the
  // reference's own clock is FX provenance, not an observation of this token.
  const referenceType = getReferenceType(references, config.pegType);
  if (referenceType !== "fresh" && referenceType !== "static") return null;

  const rate = references?.rates[config.pegType];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
  return rate;
}

export const protocolParProvider: PriceSourceProvider = {
  source: PROTOCOL_PAR_SOURCE,
  livePriority: 0,
  matches(stablecoinId: string): boolean {
    return PROTOCOL_PAR_PRICE_CONFIGS_BY_ID.has(stablecoinId);
  },
  async fetchLivePrice(
    asset: PeggedAsset,
    context: LivePriceContext,
  ): Promise<CurrentPriceOverride | null> {
    const config = PROTOCOL_PAR_PRICE_CONFIGS_BY_ID.get(asset.id);
    if (!config) return null;

    const price = getProtocolParPrice(config, context.validationReferences);
    if (price == null) return null;

    return {
      price,
      source: PROTOCOL_PAR_SOURCE,
      confidence: null,
      observedAt: null,
      observedAtMode: "nominal_reference",
    };
  },
  // Nominal par has no observed history. Matching every route with an empty
  // series makes depeg replay preserve existing rows instead of synthesizing
  // par points or replaying unadmitted market history.
  async fetchHistoricalPrices(): Promise<HistoricalPricePoint[] | null> {
    return null;
  },
};
