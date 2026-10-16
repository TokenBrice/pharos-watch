import { describe, expect, it } from "vitest";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import {
  getMintBurnRunState,
  resolveRotatedConfigs,
  setMintBurnRunState,
} from "../mint-burn/run-state";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";

describe("resolveRotatedConfigs", () => {
  const configs = [
    { key: "ethereum-0xaaa" },
    { key: "ethereum-0xbbb" },
    { key: "ethereum-0xccc" },
  ];
  const keyFn = (c: { key: string }) => c.key;

  it("starts at the persisted resume frontier", () => {
    expect(resolveRotatedConfigs("ethereum-0xaaa", configs, keyFn)).toEqual([
      configs[0], configs[1], configs[2],
    ]);
    expect(resolveRotatedConfigs("ethereum-0xbbb", configs, keyFn)).toEqual([
      configs[1], configs[2], configs[0],
    ]);
  });

  it("wraps around at end of list", () => {
    expect(resolveRotatedConfigs("ethereum-0xccc", configs, keyFn)).toEqual([
      configs[2], configs[0], configs[1],
    ]);
  });

  it("returns original order when key not found (config was removed)", () => {
    expect(resolveRotatedConfigs("ethereum-0xzzz", configs, keyFn)).toEqual(configs);
  });

  it("returns original order when key is null (first run)", () => {
    expect(resolveRotatedConfigs(null, configs, keyFn)).toEqual(configs);
  });

  it("round-trips and replaces the durable resume frontier", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    const db = createSqliteD1(sqlite);
    const fullSet = Array.from({ length: 127 }, (_, index) => ({ key: `config-${index}` }));

    try {
      await setMintBurnRunState(db, "sync-mint-burn-extended", 0, "config-94");
      const beforeCrash = await getMintBurnRunState(db, "sync-mint-burn-extended");
      expect(resolveRotatedConfigs(beforeCrash.state.resumeConfigKey, fullSet, keyFn)[0]?.key)
        .toBe("config-94");


      await setMintBurnRunState(db, "sync-mint-burn-extended", 0, "config-61");
      const afterSuccessfulRetry = await getMintBurnRunState(db, "sync-mint-burn-extended");
      expect(afterSuccessfulRetry.state.resumeConfigKey).toBe("config-61");
    } finally {
      sqlite.close();
    }
  });
});
