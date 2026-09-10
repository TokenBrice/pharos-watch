import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LIVE_RESERVE_ADAPTER_DEFINITIONS,
  LiveReservesConfigSchema,
} from "@shared/lib/live-reserve-adapters";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";

const COIN_SOURCE_DIR = join(process.cwd(), "shared/data/stablecoins/coins");

const RESERVE_SOURCE_DIR = join(process.cwd(), "shared/data/stablecoins/domains/reserves");

interface CoinSource {
  liveReservesConfig?: {
    adapter: keyof typeof LIVE_RESERVE_ADAPTER_DEFINITIONS;
    scoring?: { maxSourceAgeSec?: number };
    inputs?: { primary?: { chain?: string } };
    params?: { slice?: { expectedAssetAddress?: string } };
  };
}

let coinSources: Map<string, CoinSource> | undefined;

function getCoinSources(): Map<string, CoinSource> {
  return coinSources ??= new Map(
    readdirSync(COIN_SOURCE_DIR)
      .filter((fileName) => fileName.endsWith(".json"))
      .map((fileName) => [
        fileName.slice(0, -5),
        JSON.parse(readFileSync(join(COIN_SOURCE_DIR, fileName), "utf8")) as CoinSource,
      ]),
  );
}

interface ReserveSource {
  reserves?: Array<{ sourceKey?: string }>;
}

let erc4626SidecarKeys: Set<string> | undefined;

function getErc4626SidecarKeys(): Set<string> {
  return (erc4626SidecarKeys ??= new Set(
    readdirSync(RESERVE_SOURCE_DIR)
      .filter((fileName) => fileName.endsWith(".json"))
      .flatMap((fileName) => {
        const sidecar = JSON.parse(readFileSync(join(RESERVE_SOURCE_DIR, fileName), "utf8")) as ReserveSource;
        return (sidecar.reserves ?? [])
          .map((row) => row.sourceKey?.toLowerCase() ?? "")
          .filter((sourceKey) => sourceKey.startsWith("erc4626-single-asset:"));
      }),
  ));
}


describe("live reserve catalog integrity", () => {
  it("accepts configured live reserve URLs", () => {
    const failures: string[] = [];

    for (const coin of ACTIVE_STABLECOINS) {
      if (!coin.liveReservesConfig) continue;
      const parsed = LiveReservesConfigSchema.safeParse(coin.liveReservesConfig);
      if (!parsed.success) {
        failures.push(
          `${coin.id}: ${parsed.error.issues[0]?.path.join(".") ?? "config"} ${parsed.error.issues[0]?.message ?? "invalid"}`,
        );
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps every bound source-age override at or below its adapter cap", () => {
    const failures: string[] = [];
    // Read source JSONs as well as active bindings so suspended configurations are covered.
    for (const [id, source] of getCoinSources()) {
      const config = source.liveReservesConfig;
      const coinCap = config?.scoring?.maxSourceAgeSec;
      if (!config || coinCap == null) continue;
      const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS[config.adapter];
      const adapterCap = "validation" in definition && "maxSourceAgeSec" in definition.validation
        ? definition.validation.maxSourceAgeSec
        : undefined;
      if (adapterCap != null && coinCap > adapterCap) {
        failures.push(`${id}: coin=${coinCap} adapter=${adapterCap}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("covers every erc4626-single-asset coin with a reviewed reserve slice", () => {
    const failures: string[] = [];
    const sidecarKeys = getErc4626SidecarKeys();
    for (const [id, source] of getCoinSources()) {
      const config = source.liveReservesConfig;
      if (!config || config.adapter !== "erc4626-single-asset") continue;
      const chain = config.inputs?.primary?.chain;
      const asset = config.params?.slice?.expectedAssetAddress?.toLowerCase();
      // The adapter emits `erc4626-single-asset:<chain>:<vault underlying>`; the
      // reviewed sidecar slice must carry the same key. sgho-aave follows this
      // rule too — the savings passthrough is keyed by the GHO underlying.
      const sourceKey = chain && asset ? `erc4626-single-asset:${chain}:${asset}` : undefined;
      if (!sourceKey || !sidecarKeys.has(sourceKey)) {
        failures.push(`${id}: no reserve slice keyed ${sourceKey ?? "erc4626-single-asset:<chain>:<underlying>"}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
