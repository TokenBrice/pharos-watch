import { describe, expect, it } from "vitest";
import { withEnv } from "./helpers/test-state";

import {
  chunkOverflowRoutes,
  getOverflowWorkerCount,
} from "../maintenance/smoke-ui.mjs";

describe("getOverflowWorkerCount", () => {
  it("allows env overrides while capping workers to six and route count", () => {
    withEnv("SMOKE_UI_OVERFLOW_WORKERS", "8", () => {
      expect(getOverflowWorkerCount("local", 11)).toBe(6);
      expect(getOverflowWorkerCount("local", 2)).toBe(2);
    });
  });
});

describe("chunkOverflowRoutes", () => {
  it("returns no chunks for empty input or disabled workers", () => {
    expect(chunkOverflowRoutes([], 2)).toEqual([]);
    expect(chunkOverflowRoutes(["/"], 0)).toEqual([]);
  });
});
