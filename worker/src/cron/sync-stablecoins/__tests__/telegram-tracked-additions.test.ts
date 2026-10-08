import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { queueTrackedAdditionsNotice } from "../telegram-tracked-additions";
import { getCache } from "../../../lib/db-cache";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makePeggedAsset } from "./_fixtures";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.restoreAllMocks(); });

describe("tracked-addition publication adapter", () => {
  it("persists only newly tracked IDs and does not duplicate the pending notice", async () => {
    const { db } = fixtures.open();
    const assets = [
      makePeggedAsset({ id: "usdt-tether" }),
      makePeggedAsset({ id: "usdc-circle" }),
      makePeggedAsset({ id: "not-a-tracked-coin" }),
    ];
    await queueTrackedAdditionsNotice(db, new Set(["usdt-tether"]), assets);
    expect(JSON.parse((await getCache(db, "telegram:tracked-stablecoins-pending"))!.value)).toEqual(["usdc-circle"]);
    await queueTrackedAdditionsNotice(db, ["usdt-tether"], assets);
    expect(JSON.parse((await getCache(db, "telegram:tracked-stablecoins-pending"))!.value)).toEqual(["usdc-circle"]);
  });

  it("does not announce every asset when the previous baseline is unavailable", async () => {
    const { db } = fixtures.open();
    await queueTrackedAdditionsNotice(db, [], [makePeggedAsset({ id: "usdc-circle" })]);
    expect(await getCache(db, "telegram:tracked-stablecoins-pending")).toBeNull();
  });

  it("does not fail stablecoin publication when the notice queue read fails", async () => {
    const db = mockD1([]);
    vi.spyOn(db, "prepare").mockImplementation(() => { throw new Error("queue unavailable"); });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(queueTrackedAdditionsNotice(db, ["usdt-tether"], [makePeggedAsset({ id: "usdc-circle" })])).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalled();
  });
});
