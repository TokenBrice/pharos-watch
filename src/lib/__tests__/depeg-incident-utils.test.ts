import { describe, expect, it } from "vitest";
import { extractPendingDepegIncidents } from "../depeg-incident-utils";

describe("extractPendingDepegIncidents", () => {
  it("returns no incidents before data arrives or when pending is absent", () => {
    expect(extractPendingDepegIncidents(undefined)).toEqual([]);
    expect(extractPendingDepegIncidents({})).toEqual([]);
    expect(extractPendingDepegIncidents({ pending: [] })).toEqual([]);
  });

});

