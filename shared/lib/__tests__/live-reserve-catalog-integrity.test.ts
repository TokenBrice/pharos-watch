import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
  LIVE_RESERVE_ADAPTER_DEFINITIONS,
  LiveReservesConfigSchema,
  QUARTERLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
} from "@shared/lib/live-reserve-adapters";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";

const LATE_MONTHLY_SOURCE_AGE_IDS = [
  "audm-mento",
  "bib01-backed",
  "brlm-mento",
  "btcusd-btcfi",
  "cadm-mento",
  "ceur-celo",
  "chfm-mento",
  "copm-mento",
  "cusd-celo",
  "deuro-deuro",
  "fdusd-first-digital",
  "gbpm-mento",
  "ghsm-mento",
  "iusd-infinifi",
  "jpym-mento",
  "kesm-mento",
  "srusd-reservoir",
  "usdy-ondo-finance",
  "uty-xsy",
  "wsrusd-reservoir",
  "xsgd-straitsx",
  "zarm-mento",
  "zchf-frankencoin",
] as const;

const INDEPENDENT_ASSURANCE_SOURCE_AGE_POLICIES = {
  "audx-independent-assurance": LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
  "europ-independent-assurance": QUARTERLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
  "straitsx-independent-assurance": LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC,
} as const;

const COIN_SOURCE_DIR = join(process.cwd(), "shared/data/stablecoins/coins");

interface CoinSource {
  liveReservesConfig?: { scoring?: { maxSourceAgeSec?: number } };
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

function readCoinSource(id: string): CoinSource {
  const source = getCoinSources().get(id);
  if (!source) throw new Error(`Missing coin source: ${id}`);
  return source;
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

  it("requires independent-assurance coins to pin the declaration source-age cap", () => {
    const failures: string[] = [];

    for (const coin of ACTIVE_STABLECOINS) {
      const config = coin.liveReservesConfig;
      if (!config || !(config.adapter in INDEPENDENT_ASSURANCE_SOURCE_AGE_POLICIES)) continue;

      const expectedCap =
        INDEPENDENT_ASSURANCE_SOURCE_AGE_POLICIES[
          config.adapter as keyof typeof INDEPENDENT_ASSURANCE_SOURCE_AGE_POLICIES
        ];
      // Adapter declarations are heterogeneous; this comparison only needs optional validation metadata.
      const adapterDefinition = LIVE_RESERVE_ADAPTER_DEFINITIONS[config.adapter] as {
        validation?: { maxSourceAgeSec?: number };
      };
      const declarationCap = adapterDefinition.validation?.maxSourceAgeSec;
      const sourceConfig = readCoinSource(coin.id).liveReservesConfig;
      if (declarationCap !== expectedCap || sourceConfig?.scoring?.maxSourceAgeSec !== expectedCap) {
        failures.push(
          `${coin.id}: declaration=${String(declarationCap)} coin=${String(sourceConfig?.scoring?.maxSourceAgeSec)} expected=${expectedCap}`,
        );
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps reviewed late-monthly source-age overrides tied to the named policy", () => {
    const failures = LATE_MONTHLY_SOURCE_AGE_IDS.flatMap((id) => {
      const maxSourceAgeSec = readCoinSource(id).liveReservesConfig?.scoring?.maxSourceAgeSec;
      return maxSourceAgeSec === LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC
        ? []
        : [`${id}: expected ${LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC}, got ${String(maxSourceAgeSec)}`];
    });

    expect(failures).toEqual([]);
  });

  it("does not leave late-monthly-ish caps outside the named policy value", () => {
    const adHocCaps = [...getCoinSources()].flatMap(([id, source]) => {
      const maxSourceAgeSec = source.liveReservesConfig?.scoring?.maxSourceAgeSec;
      const isLateMonthlyRange =
        maxSourceAgeSec != null && maxSourceAgeSec >= 3_900_000 && maxSourceAgeSec <= 4_100_000;
      return isLateMonthlyRange && maxSourceAgeSec !== LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC
        ? [`${id}.json: ${maxSourceAgeSec}`]
        : [];
    });

    expect(adHocCaps).toEqual([]);
  });
});
