import type { LiveReservesConfig, StablecoinMeta } from "@shared/types";
import type { AdapterContext, AdapterResult } from "./index";
import { fetchOnchainUint256, requireOnchainInput, slicesFromValues } from "./helpers";

const GHO_TOKEN = "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f";
const GSM_USDC = "0xFeeb6FE430B7523fEF2a38327241eE7153779535";
const GSM_USDT = "0x535b2f7C20B9C83d70e519cf9991578eF9816B7B";

const BALANCE_OF = "0x70a08231";
const TOTAL_SUPPLY_SELECTOR = "0x18160ddd";

const USDC_TOKEN = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT_TOKEN = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

export interface GhoFacilitatorData {
  facilitators: Array<{ label: string; bucketLevel: bigint; bucketCapacity: bigint }>;
  gsmUsdc: bigint;
  gsmUsdt: bigint;
}

export function adaptGhoFacilitators(data: GhoFacilitatorData): AdapterResult {
  const values: Array<{ name: string; value: number; risk: "very-low" | "low" | "medium" | "high" | "very-high"; coinId?: string }> = [];

  for (const f of data.facilitators) {
    const level = Number(f.bucketLevel);
    if (level <= 0) continue;
    values.push({
      name: f.label,
      value: level,
      risk: "medium",
    });
  }

  const gsmUsdcVal = Number(data.gsmUsdc);
  if (gsmUsdcVal > 0) {
    values.push({ name: "GSM USDC", value: gsmUsdcVal, risk: "low", coinId: "usdc-circle" });
  }

  const gsmUsdtVal = Number(data.gsmUsdt);
  if (gsmUsdtVal > 0) {
    values.push({ name: "GSM USDT", value: gsmUsdtVal, risk: "low", coinId: "usdt-tether" });
  }

  if (values.length === 0) return { slices: [] };

  return {
    slices: slicesFromValues(values),
    metadata: {
      facilitatorCount: data.facilitators.length,
      activeFacilitatorCount: data.facilitators.filter((f) => f.bucketLevel > 0n).length,
    },
  };
}

export async function fetchGhoReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireOnchainInput(config.inputs.primary, "gho");
  if (input.chain !== "ethereum") {
    throw new Error(`gho adapter only supports ethereum, got "${input.chain}"`);
  }
  const params = config.params as Record<string, unknown> | undefined;
  const callOpts = {
    rpcMode: input.rpcMode,
    chain: input.chain,
    signal,
    ctx,
    rpcUrl: typeof params?.rpcUrl === "string" ? params.rpcUrl : undefined,
    fallbackRpcUrl: typeof params?.fallbackRpcUrl === "string" ? params.fallbackRpcUrl : undefined,
  };

  const [gsmUsdc, gsmUsdt, totalSupply] = await Promise.all([
    fetchOnchainUint256({
      contract: USDC_TOKEN,
      data: BALANCE_OF + GSM_USDC.slice(2).padStart(64, "0"),
      ...callOpts,
    }),
    fetchOnchainUint256({
      contract: USDT_TOKEN,
      data: BALANCE_OF + GSM_USDT.slice(2).padStart(64, "0"),
      ...callOpts,
    }),
    fetchOnchainUint256({
      contract: GHO_TOKEN,
      data: TOTAL_SUPPLY_SELECTOR,
      ...callOpts,
    }),
  ]);

  if (gsmUsdc == null || gsmUsdt == null || totalSupply == null) {
    throw new Error("gho: failed to read one or more on-chain values");
  }

  // GHO has 18 decimals, USDC has 6, USDT has 6
  const gsmUsdcScaled = gsmUsdc * 10n ** 12n;
  const gsmUsdtScaled = gsmUsdt * 10n ** 12n;
  const facilitatorMinted = totalSupply - gsmUsdcScaled - gsmUsdtScaled;

  return adaptGhoFacilitators({
    facilitators: [
      {
        label: "Aave V3 Ethereum (overcollateralized)",
        bucketLevel: facilitatorMinted > 0n ? facilitatorMinted : 0n,
        bucketCapacity: 0n,
      },
    ],
    gsmUsdc: gsmUsdcScaled,
    gsmUsdt: gsmUsdtScaled,
  });
}
