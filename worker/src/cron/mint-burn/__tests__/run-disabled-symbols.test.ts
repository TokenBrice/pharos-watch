import type { D1Database } from "@shared/types/cloudflare-runtime";
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
const POLICY_SELECT = "SELECT disabled_keys, paused_keys FROM mint_burn_publication_policy";

/**
 * Fail the durable-policy SELECT's first() the given number of times. The
 * statement object is mutated in place because sqlite-d1's batch() resolves its
 * executor by statement identity.
 */
function flakyPolicyRead(db: D1Database, failures: number) {
  let attempts = 0;
  const prepare = db.prepare.bind(db);
  const wrapped = Object.create(db) as D1Database;
  wrapped.prepare = (sql: string) => {
    const statement = prepare(sql);
    if (!sql.includes(POLICY_SELECT)) return statement;
    const mutable = statement as unknown as { first: (...args: unknown[]) => Promise<unknown> };
    const first = mutable.first.bind(statement);
    mutable.first = async (...args: unknown[]) => {
      attempts += 1;
      if (attempts <= failures) throw new Error("D1 DB is overloaded");
      return first(...args);
    };
    return statement;
  };
  return { db: wrapped, attempts: () => attempts };
}

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

  it("retries a transient policy read instead of erasing a retained disable", async () => {
    const { db, sqlite } = fixtures.open();
    const yusdKey = YUSD_KEYS[0]!;
    sqlite.prepare(
      `INSERT INTO mint_burn_publication_policy (id, disabled_keys, paused_keys, updated_at)
       VALUES (1, ?, '[]', ?)`,
    ).run(JSON.stringify([yusdKey]), Math.floor(Date.now() / 1000));
    const flaky = flakyPolicyRead(db, 1);
    const disabledConfigIds = MINT_BURN_CONFIGS
      .filter((config) => config.symbol.toUpperCase() !== "YUSD")
      .map(mintBurnConfigKey);

    const result = await new MintBurnRun(flaky.db, "alchemy-key", {
      lane: "critical",
      disabledConfigIds,
      disabledSymbols: ["YUSD"],
    }).execute();

    expect(result.status).toBe("ok");
    // One overloaded attempt, then the retry reads the retained key.
    expect(flaky.attempts()).toBe(2);
    const policy = JSON.parse(String((sqlite.prepare(
      "SELECT disabled_keys FROM mint_burn_publication_policy WHERE id = 1",
    ).get() as { disabled_keys: string }).disabled_keys)) as string[];
    expect(policy).toContain(yusdKey);
  });

  it("fails the lane closed without rewriting the policy when the read stays unavailable", async () => {
    const { db, sqlite } = fixtures.open();
    const yusdKey = YUSD_KEYS[0]!;
    sqlite.prepare(
      `INSERT INTO mint_burn_publication_policy (id, disabled_keys, paused_keys, updated_at)
       VALUES (1, ?, '[]', ?)`,
    ).run(JSON.stringify([yusdKey]), Math.floor(Date.now() / 1000));
    const before = sqlite.prepare(
      "SELECT disabled_keys, paused_keys, updated_at FROM mint_burn_publication_policy WHERE id = 1",
    ).get();
    const flaky = flakyPolicyRead(db, 4);
    const disabledConfigIds = MINT_BURN_CONFIGS
      .filter((config) => config.symbol.toUpperCase() !== "YUSD")
      .map(mintBurnConfigKey);

    await expect(new MintBurnRun(flaky.db, "alchemy-key", {
      lane: "critical",
      disabledConfigIds,
      disabledSymbols: ["YUSD"],
    }).execute()).rejects.toThrow("D1 DB is overloaded");

    expect(flaky.attempts()).toBe(4);
    expect(sqlite.prepare(
      "SELECT disabled_keys, paused_keys, updated_at FROM mint_burn_publication_policy WHERE id = 1",
    ).get()).toEqual(before);
  });

  it("fails the run closed on a corrupt paused_keys value and leaves the row for repair", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.prepare(
      `INSERT INTO mint_burn_publication_policy (id, disabled_keys, paused_keys, updated_at)
       VALUES (1, '[]', 'not-json', ?)`,
    ).run(Math.floor(Date.now() / 1000));
    const disabledConfigIds = MINT_BURN_CONFIGS
      .filter((config) => config.symbol.toUpperCase() !== "USDC")
      .map(mintBurnConfigKey);

    await expect(new MintBurnRun(db, "alchemy-key", {
      lane: "critical",
      disabledConfigIds,
      disabledSymbols: ["USDC"],
    }).execute()).rejects.toThrow();

    expect((sqlite.prepare(
      "SELECT paused_keys FROM mint_burn_publication_policy WHERE id = 1",
    ).get() as { paused_keys: string }).paused_keys).toBe("not-json");
  });
});
