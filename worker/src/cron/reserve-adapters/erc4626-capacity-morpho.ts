import { canonicalEvmAddress } from "@shared/lib/evm-address";
import { toErrorMessage } from "@shared/lib/error-utils";
import type { LiveReserveWarning } from "@shared/types/live-reserves";
import { decodeStrictAddressWord } from "./abi-decode";
import { fetchJsonPostWithRetry, reserveDegradedWarning, reserveInfoWarning } from "./helpers";
import { parseDecimalNumber } from "./strict-amount";
import {
  probeFailure, routeForSource,
  type CapacityProbeResult, type Erc4626RedemptionLiquidityConfig, type ObserveConfiguredErc4626CapacityInput,
} from "./erc4626-capacity-observation";

type MorphoVaultV1RedemptionLiquidityConfig = Extract<Erc4626RedemptionLiquidityConfig, { source: "morpho-vault-v1" }>;
type MorphoVaultV2RedemptionLiquidityConfig = Extract<Erc4626RedemptionLiquidityConfig, { source: "morpho-vault-v2" }>;

type MorphoProbeInput = Pick<ObserveConfiguredErc4626CapacityInput, "coinId" | "contractAddress" | "assetAddress" | "signal" | "ctx">;

interface MorphoVaultWarning {
  type?: unknown;
  level?: unknown;
}

type MorphoV1Liquidity = { underlying?: unknown; usd?: unknown };
interface MorphoVault {
  address?: unknown;
  listed?: unknown;
  asset?: { address?: unknown } | null;
  chain?: { id?: unknown } | null;
  warnings?: unknown;
  liquidity?: unknown;
  liquidityUsd?: unknown;
  forceDeallocatableLiquidity?: unknown;
  forceDeallocatableLiquidityUsd?: unknown;
}

type MorphoVaultResponse = {
  data?: { vaultByAddress?: MorphoVault | null; vaultV2ByAddress?: MorphoVault | null };
  errors?: unknown;
};
type ParsedMorphoVaultLiquidity = {
  liquidityRaw: bigint | null;
  liquidityUsd?: number;
  forceDeallocatableLiquidityRaw?: bigint;
  forceDeallocatableLiquidityUsd?: number;
};
const DEFAULT_MORPHO_GRAPHQL_URL = "https://api.morpho.org/graphql";
const MORPHO_VAULT_V1_LIQUIDITY_QUERY = `
query PharosVaultV1Liquidity($address: String!, $chainId: Int!) {
  vaultByAddress(address: $address, chainId: $chainId) {
    address
    listed
    asset {
      address
    }
    chain {
      id
    }
    liquidity {
      underlying
      usd
    }
    warnings {
      type
      level
    }
  }
}
`;

const MORPHO_VAULT_V2_LIQUIDITY_QUERY = `
query PharosVaultV2Liquidity($address: String!, $chainId: Int!) {
  vaultV2ByAddress(address: $address, chainId: $chainId) {
    address
    listed
    asset {
      address
    }
    chain {
      id
    }
    liquidity
    liquidityUsd
    forceDeallocatableLiquidity
    forceDeallocatableLiquidityUsd
    warnings {
      type
      level
    }
  }
}
`;

function parseOptionalNonNegativeNumber(value: unknown): number | undefined {
  if (value == null) return undefined;
  const parsed = parseDecimalNumber(value);
  return parsed != null && parsed >= 0 ? parsed : undefined;
}

function parseMorphoChainId(value: unknown): number | null {
  const parsed = parseDecimalNumber(value);
  return parsed != null && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseNonNegativeBigIntLike(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = BigInt(trimmed);
  return parsed >= 0n ? parsed : null;
}

function describeMorphoWarning(value: unknown): string {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return "malformed";
  const warning = value as MorphoVaultWarning;
  const type = typeof warning.type === "string" ? warning.type : "unknown";
  const level = typeof warning.level === "string" ? warning.level : "unknown";
  return `${type}/${level}`;
}

function classifyMorphoV2Warning(value: unknown): LiveReserveWarning | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const warning = value as MorphoVaultWarning;
  if (warning.type === "deposit_disabled" && warning.level === "RED") {
    return reserveInfoWarning(
      "morpho-vault-v2-deposit-disabled",
      "Morpho V2 reports deposit_disabled/RED; API liquidity is diagnostic only",
    );
  }
  if (warning.type === "low_liquidity" && warning.level === "YELLOW") {
    return reserveInfoWarning(
      "morpho-vault-v2-low-liquidity",
      "Morpho V2 reports low_liquidity/YELLOW; withdrawals remain degraded and capacity is idle-only",
    );
  }
  return null;
}

function morphoFailure(
  input: { warningCodePrefix: string; versionLabel: string; coinId: string },
  code: string,
  detail: string,
): CapacityProbeResult {
  return probeFailure(
    `${input.warningCodePrefix}-${code}`,
    `${input.versionLabel} ${detail} for ${input.coinId}`,
  );
}

type MorphoQueryInput = MorphoProbeInput & {
  config: { chainId: number; apiUrl?: string };
  query: string;
  versionLabel: "Morpho V1" | "Morpho V2";
  warningCodePrefix: "morpho-vault-v1" | "morpho-vault-v2";
  extractVault: (payload: MorphoVaultResponse) => MorphoVault | null | undefined;
  parseLiquidity: (vault: MorphoVault) => ParsedMorphoVaultLiquidity;
};

async function fetchMorphoVaultLiquidity(input: MorphoQueryInput): Promise<CapacityProbeResult> {
  const apiUrl = input.config.apiUrl ?? DEFAULT_MORPHO_GRAPHQL_URL;
  try {
    const payload = await fetchJsonPostWithRetry<MorphoVaultResponse>(
      apiUrl,
      {
        query: input.query,
        variables: {
          address: input.contractAddress,
          chainId: input.config.chainId,
        },
      },
      input.signal,
      12_000,
      input.ctx,
      { headers: { Accept: "application/json" } },
    );
    if (payload.errors != null) {
      return morphoFailure(input, "liquidity-unavailable", "liquidity query returned GraphQL errors");
    }

    const vault = input.extractVault(payload);
    if (!vault) {
      return morphoFailure(input, "liquidity-unavailable", "liquidity query returned no vault");
    }
    if (canonicalEvmAddress(vault.address) !== input.contractAddress.toLowerCase()) {
      return morphoFailure(input, "identity-mismatch", "liquidity vault address mismatch");
    }
    if (canonicalEvmAddress(vault.asset?.address) !== input.assetAddress.toLowerCase()) {
      return morphoFailure(input, "asset-mismatch", "liquidity asset mismatch");
    }
    if (parseMorphoChainId(vault.chain?.id) !== input.config.chainId) {
      return morphoFailure(input, "chain-mismatch", "liquidity chain mismatch");
    }
    if (vault.listed !== true) {
      return morphoFailure(input, "unlisted", "liquidity vault is not listed");
    }
    const isVaultV1 = input.warningCodePrefix === "morpho-vault-v1";
    if (vault.warnings != null && !Array.isArray(vault.warnings)) {
      return morphoFailure(input, "warning", "liquidity warnings field is malformed");
    }

    const liquidity = input.parseLiquidity(vault);
    if (
      liquidity.liquidityRaw == null
      || (!isVaultV1 && (
        (vault.liquidityUsd != null && liquidity.liquidityUsd == null)
        || (vault.forceDeallocatableLiquidity != null && liquidity.forceDeallocatableLiquidityRaw == null)
        || (vault.forceDeallocatableLiquidityUsd != null && liquidity.forceDeallocatableLiquidityUsd == null)
      ))
    ) {
      return morphoFailure(input, "liquidity-invalid", "liquidity payload has invalid liquidity");
    }
    if (Array.isArray(vault.warnings) && vault.warnings.length > 0) {
      const warningList = vault.warnings.map(describeMorphoWarning).join(", ");
      const reviewedWarnings: LiveReserveWarning[] = [];
      if (!isVaultV1) {
        for (const warning of vault.warnings) {
          const reviewed = classifyMorphoV2Warning(warning);
          if (reviewed != null) reviewedWarnings.push(reviewed);
        }
      }
      const allReviewed = reviewedWarnings.length === vault.warnings.length;
      const lowLiquidity = reviewedWarnings.some((warning) => warning.code === "morpho-vault-v2-low-liquidity");
      return {
        capacityRaw: null,
        warnings: allReviewed ? reviewedWarnings : [reserveDegradedWarning(
          `${input.warningCodePrefix}-warning`,
          `${input.versionLabel} liquidity vault warnings for ${input.coinId}: ${warningList}`,
        )],
        ...(lowLiquidity ? {
          route: {
            freshnessKind: "same-run-api",
            routeStatus: "degraded",
            routeStatusSource: "protocol-api",
            routeStatusReason: "Morpho V2 reports low_liquidity/YELLOW",
          },
        } : {}),
        diagnostics: { morphoWarnings: vault.warnings },
      };
    }
    return {
      capacityRaw: liquidity.liquidityRaw,
      warnings: [],
      route: routeForSource(
        isVaultV1 ? "morpho-vault-v1-liquidity" : "morpho-vault-v2-liquidity",
      ),
      diagnostics: {},
      telemetry: isVaultV1
        ? {
            morphoVaultV1LiquidityRaw: liquidity.liquidityRaw.toString(),
            ...(liquidity.liquidityUsd != null
              ? { morphoVaultV1LiquidityUsd: liquidity.liquidityUsd }
              : {}),
          }
        : {
            morphoVaultV2LiquidityRaw: liquidity.liquidityRaw.toString(),
            ...(liquidity.liquidityUsd != null
              ? { morphoVaultV2LiquidityUsd: liquidity.liquidityUsd }
              : {}),
            ...(liquidity.forceDeallocatableLiquidityRaw != null
              ? {
                  morphoVaultV2ForceDeallocatableLiquidityRaw:
                    liquidity.forceDeallocatableLiquidityRaw.toString(),
                }
              : {}),
            ...(liquidity.forceDeallocatableLiquidityUsd != null
              ? {
                  morphoVaultV2ForceDeallocatableLiquidityUsd:
                    liquidity.forceDeallocatableLiquidityUsd,
                }
              : {}),
          },
    };
  } catch (error) {
    return probeFailure(`${input.warningCodePrefix}-liquidity-unavailable`, `${input.versionLabel} liquidity fetch failed for ${input.coinId}: ${toErrorMessage(error)}`);
  }
}

export async function fetchMorphoVaultV2Liquidity(
  input: MorphoProbeInput & Pick<ObserveConfiguredErc4626CapacityInput, "call"> & {
    config: MorphoVaultV2RedemptionLiquidityConfig;
  },
): Promise<CapacityProbeResult> {
  // Ordinary exit() can deallocate only through the vault's selected adapter.
  // GraphQL liquidity alone is not callable withdrawal capacity when it is unset.
  const adapter = decodeStrictAddressWord(await input.call("0xad468d11").catch(() => null));
  if (adapter == null || adapter === "0x0000000000000000000000000000000000000000") {
    const reason = adapter == null ? "unavailable" : "zero";
    return {
      capacityRaw: null,
      warnings: [reserveInfoWarning(
        `morpho-vault-v2-liquidity-adapter-${reason}`,
        `Morpho V2 liquidityAdapter() ${reason}; only independently observed idle underlying is usable as capacity`,
      )],
    };
  }
  return fetchMorphoVaultLiquidity({
    ...input,
    query: MORPHO_VAULT_V2_LIQUIDITY_QUERY,
    versionLabel: "Morpho V2",
    warningCodePrefix: "morpho-vault-v2",
    extractVault: (payload) => payload.data?.vaultV2ByAddress,
    parseLiquidity: (vault) => {
      const liquidityUsd = parseOptionalNonNegativeNumber(vault.liquidityUsd);
      const forceDeallocatableLiquidityRaw = parseNonNegativeBigIntLike(vault.forceDeallocatableLiquidity);
      const forceDeallocatableLiquidityUsd = parseOptionalNonNegativeNumber(vault.forceDeallocatableLiquidityUsd);
      return {
        liquidityRaw: parseNonNegativeBigIntLike(vault.liquidity),
        ...(liquidityUsd != null ? { liquidityUsd } : {}),
        ...(forceDeallocatableLiquidityRaw != null ? { forceDeallocatableLiquidityRaw } : {}),
        ...(forceDeallocatableLiquidityUsd != null ? { forceDeallocatableLiquidityUsd } : {}),
      };
    },
  });
}

export function fetchMorphoVaultV1Liquidity(
  input: MorphoProbeInput & { config: MorphoVaultV1RedemptionLiquidityConfig },
): Promise<CapacityProbeResult> {
  return fetchMorphoVaultLiquidity({
    ...input,
    query: MORPHO_VAULT_V1_LIQUIDITY_QUERY,
    versionLabel: "Morpho V1",
    warningCodePrefix: "morpho-vault-v1",
    extractVault: (payload) => payload.data?.vaultByAddress,
    parseLiquidity: (vault) => {
      const liquidity = vault.liquidity as MorphoV1Liquidity | null | undefined;
      const liquidityUsd = parseOptionalNonNegativeNumber(liquidity?.usd);
      return {
        liquidityRaw: parseNonNegativeBigIntLike(liquidity?.underlying),
        ...(liquidityUsd != null ? { liquidityUsd } : {}),
      };
    },
  });
}
