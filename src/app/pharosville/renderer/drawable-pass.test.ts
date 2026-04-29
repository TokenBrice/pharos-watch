import { describe, expect, it } from "vitest";
import {
  drawablePassCounts,
  sortWorldDrawables,
  type WorldDrawable,
} from "./drawable-pass";

function drawable(input: Pick<WorldDrawable, "depth" | "kind" | "pass" | "tieBreaker">): WorldDrawable {
  return {
    detailId: input.tieBreaker,
    draw: () => undefined,
    entityId: input.tieBreaker,
    screenBounds: { height: 1, width: 1, x: 0, y: 0 },
    ...input,
  };
}

describe("drawable-pass", () => {
  it("orders drawables by pass, depth, kind, and stable tie breaker", () => {
    const sorted = sortWorldDrawables([
      drawable({ depth: 100, kind: "ship", pass: "body", tieBreaker: "c" }),
      drawable({ depth: 10, kind: "ship", pass: "overlay", tieBreaker: "d" }),
      drawable({ depth: 200, kind: "ship", pass: "underlay", tieBreaker: "a" }),
      drawable({ depth: 100, kind: "dock", pass: "body", tieBreaker: "b" }),
      drawable({ depth: 1, kind: "ship", pass: "selection", tieBreaker: "e" }),
    ]);

    expect(sorted.map((entry) => entry.tieBreaker)).toEqual(["d", "b", "c", "a", "e"]);
  });

  it("counts drawables by pass", () => {
    expect(drawablePassCounts([
      drawable({ depth: 1, kind: "ship", pass: "underlay", tieBreaker: "wake" }),
      drawable({ depth: 2, kind: "ship", pass: "body", tieBreaker: "body" }),
      drawable({ depth: 3, kind: "ship", pass: "overlay", tieBreaker: "logo" }),
      drawable({ depth: 4, kind: "ship", pass: "selection", tieBreaker: "ring" }),
    ])).toEqual({
      body: 1,
      overlay: 1,
      selection: 1,
      underlay: 1,
    });
  });
});
