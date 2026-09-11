import { expect, it } from "vitest";
import { makeCoverageCoin } from "../coverage-coin";

it("keeps default flags independent across existing and later coins", () => {
  const first = makeCoverageCoin({ id: "first" });
  const peer = makeCoverageCoin({ id: "peer" });
  first.flags.yieldBearing = true;
  expect(peer.flags.yieldBearing).toBe(false);
  expect(makeCoverageCoin({ id: "later" }).flags.yieldBearing).toBe(false);
});
