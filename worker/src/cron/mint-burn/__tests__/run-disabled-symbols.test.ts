import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { MINT_BURN_CONFIGS } from "../../../lib/mint-burn-contracts";
import { mintBurnConfigKey } from "../../../lib/mint-burn-pipeline/sync-state";
import { syncMintBurnPublicationPolicy } from "../../../lib/mint-burn-publication";
import { MintBurnRun } from "../run";

const fixtures = createLatestSchemaFixtureTracker();
const YUSD_KEYS = MINT_BURN_CONFIGS
  .filter((config) => config.symbol.toUpperCase() === "YUSD")
  .map(mintBurnConfigKey);
const USDC_KEYS = MINT_BURN_CONFIGS
  .filter((config) => config.symbol.toUpperCase() === "USDC")
  .map(mintBurnConfigKey);

afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
});

describe("mint/burn disabled symbols", () => {
  it("retains a symbol-scoped durable disable when the ticker becomes ambiguous", async () => {
    const { db, sqlite } = fixtures.open();
    const now = Math.floor(Date.now() / 1000);
    await syncMintBurnPublicationPolicy(db, YUSD_KEYS, now);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const disabledConfigIds = MINT_BURN_CONFIGS
      .filter((config) => config.symbol.toUpperCase() !== "YUSD")
      .map(mintBurnConfigKey);

    const result = await new MintBurnRun(db, "alchemy-key", {
      lane: "critical",
      disabledConfigIds,
      disabledSymbols: ["YUSD"],
    }).execute();

    expect(result.status).toBe("ok");
    const policy = JSON.parse(String((sqlite.prepare(
      "SELECT disabled_keys FROM mint_burn_publication_policy WHERE id = 1",
    ).get() as { disabled_keys: string }).disabled_keys)) as string[];
    expect(policy).toEqual(expect.arrayContaining(YUSD_KEYS));
    expect(warn.mock.calls.some(([line]) => String(line).includes("mint_burn_disabled_symbol_ignored")))
      .toBe(true);
  });

  it("rewrites a corrupt stored disable policy instead of aborting the run", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.prepare(
      `INSERT INTO mint_burn_publication_policy (id, disabled_keys, paused_keys, updated_at)
       VALUES (1, 'not-json', '[]', ?)`,
    ).run(Math.floor(Date.now() / 1000));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const disabledConfigIds = MINT_BURN_CONFIGS
      .filter((config) => config.symbol.toUpperCase() !== "USDC")
      .map(mintBurnConfigKey);

    const result = await new MintBurnRun(db, "alchemy-key", {
      lane: "critical",
      disabledConfigIds,
      disabledSymbols: ["USDC"],
    }).execute();

    expect(result.status).toBe("ok");
    expect(warn.mock.calls.some(([line]) => String(line).includes("mint_burn_disabled_policy_unreadable")))
      .toBe(true);
    // The run's own sync rewrites the unreadable row from the env switch, so
    // an unambiguous env symbol still disables its legs and the row self-heals.
    const policy = JSON.parse(String((sqlite.prepare(
      "SELECT disabled_keys FROM mint_burn_publication_policy WHERE id = 1",
    ).get() as { disabled_keys: string }).disabled_keys)) as string[];
    expect(policy).toEqual(expect.arrayContaining(USDC_KEYS));
  });
});
