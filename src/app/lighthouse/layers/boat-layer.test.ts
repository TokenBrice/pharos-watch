import { describe, it, expect } from "vitest";
import { buildBoatLayer } from "./boat-layer";
import type { SceneBoat } from "../systems/scene-data";

const BOAT: SceneBoat = {
  coinId: "usdt",
  symbol: "USDT",
  style: "galleon",
  hullSize: "L",
  pennantHex: "#22c55e",
  homeChainId: "ethereum",
  supplyUsd: 250_000_000,
};

describe("buildBoatLayer", () => {
  it("starts empty", () => {
    const layer = buildBoatLayer();
    expect(layer.count()).toBe(0);
  });

  it("upsertBoat adds a new boat and updates an existing one", () => {
    const layer = buildBoatLayer();
    layer.upsertBoat(BOAT, { x: 100, y: 200 });
    expect(layer.count()).toBe(1);
    expect(layer.positionFor("usdt")).toEqual({ x: 100, y: 200 });
    layer.upsertBoat(BOAT, { x: 150, y: 220 });
    expect(layer.count()).toBe(1);
    expect(layer.positionFor("usdt")).toEqual({ x: 150, y: 220 });
  });

  it("pruneExcept removes boats not in the seen set", () => {
    const layer = buildBoatLayer();
    layer.upsertBoat({ ...BOAT, coinId: "a" }, { x: 0, y: 0 });
    layer.upsertBoat({ ...BOAT, coinId: "b" }, { x: 0, y: 0 });
    layer.upsertBoat({ ...BOAT, coinId: "c" }, { x: 0, y: 0 });
    layer.pruneExcept(new Set(["a", "c"]));
    expect(layer.count()).toBe(2);
    expect(layer.positionFor("b")).toBeNull();
  });

  it("removeBoat removes a single boat", () => {
    const layer = buildBoatLayer();
    layer.upsertBoat(BOAT, { x: 0, y: 0 });
    layer.removeBoat("usdt");
    expect(layer.count()).toBe(0);
  });
});
