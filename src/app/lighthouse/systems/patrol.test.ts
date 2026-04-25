import { describe, it, expect } from "vitest";
import { generatePatrolPath } from "./patrol";

describe("generatePatrolPath", () => {
  it("returns at least 4 control points", () => {
    const path = generatePatrolPath({ x: 0, y: 0 }, { x: 200, y: 100 }, "abc");
    expect(path.length).toBeGreaterThanOrEqual(4);
  });

  it("starts and ends at home (boat returns to harbour)", () => {
    const path = generatePatrolPath({ x: 10, y: 20 }, { x: 200, y: 100 }, "abc");
    expect(path[0]).toEqual({ x: 10, y: 20 });
    expect(path[path.length - 1]).toEqual({ x: 10, y: 20 });
  });

  it("is deterministic for same inputs", () => {
    const a = generatePatrolPath({ x: 0, y: 0 }, { x: 200, y: 100 }, "abc");
    const b = generatePatrolPath({ x: 0, y: 0 }, { x: 200, y: 100 }, "abc");
    expect(a).toEqual(b);
  });

  it("differs across seeds", () => {
    const a = generatePatrolPath({ x: 0, y: 0 }, { x: 200, y: 100 }, "abc");
    const b = generatePatrolPath({ x: 0, y: 0 }, { x: 200, y: 100 }, "xyz");
    expect(a).not.toEqual(b);
  });
});
