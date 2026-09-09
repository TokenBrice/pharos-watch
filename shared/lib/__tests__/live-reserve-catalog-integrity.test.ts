import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LIVE_RESERVE_ADAPTER_DEFINITIONS,
  LiveReservesConfigSchema,
} from "@shared/lib/live-reserve-adapters";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";

const COIN_SOURCE_DIR = join(process.cwd(), "shared/data/stablecoins/coins");

interface CoinSource {
  liveReservesConfig?: {
    adapter: keyof typeof LIVE_RESERVE_ADAPTER_DEFINITIONS;
    scoring?: { maxSourceAgeSec?: number };
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
});
