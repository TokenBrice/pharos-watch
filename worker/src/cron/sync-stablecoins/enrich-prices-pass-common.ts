import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins";
import {
  buildPriceReasonablenessOptions,
  isReasonablePrice,
} from "../../lib/price-validation";
import type { PricingProviderAttemptDiagnostic } from "../../lib/pricing-provider-diagnostics";
import type { PeggedAsset } from "./enrich-prices-shared";

export interface EnrichPassResult {
  resolved: number;
  failures: string[];
  diagnostics?: PricingProviderAttemptDiagnostic[];
}

export interface DlContractPassResult extends EnrichPassResult {
  pass1: number;
  pass1b: number;
}

export function sumCirculatingValue(asset: PeggedAsset): number {
  if (!asset.circulating || typeof asset.circulating !== "object") return 0;
  return Object.values(asset.circulating).reduce(
    (sum, value) => sum + (typeof value === "number" && Number.isFinite(value) ? value : 0),
    0,
  );
}

export function isUsableFallbackPrice(
  asset: PeggedAsset,
  price: number,
  fxRates: Record<string, number> | undefined,
): boolean {
  return isReasonablePrice(
    price,
    asset.pegType as string | undefined,
    fxRates,
    buildPriceReasonablenessOptions(asset),
  );
}

export const SOLANA_MINT_BY_ID = new Map<string, string>();
for (const [id, meta] of ACTIVE_META_BY_ID) {
  const deployments = [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])];
  const solanaDeployment = deployments.find((deployment) => deployment.chain === "solana");
  if (solanaDeployment?.address) {
    SOLANA_MINT_BY_ID.set(id, solanaDeployment.address);
  }
}

const activeSymbolCounts = new Map<string, number>();
for (const meta of ACTIVE_META_BY_ID.values()) {
  const symbol = meta.symbol.trim().toUpperCase();
  activeSymbolCounts.set(symbol, (activeSymbolCounts.get(symbol) ?? 0) + 1);
}

export const UNIQUE_ACTIVE_SYMBOLS = new Set(
  [...activeSymbolCounts.entries()]
    .filter(([, count]) => count === 1)
    .map(([symbol]) => symbol),
);
