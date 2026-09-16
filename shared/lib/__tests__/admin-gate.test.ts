import { describe, expect, it } from "vitest";
import { MUTATING_METHODS, X_PHAROS_ADMIN_HEADER } from "../admin-gate";

describe("admin gate primitives", () => {
  it("requires the admin marker for every HTTP mutation method and no safe method", () => {
    expect([...MUTATING_METHODS].sort()).toEqual(["DELETE", "PATCH", "POST", "PUT"]);
    expect(MUTATING_METHODS.has("GET")).toBe(false);
    expect(MUTATING_METHODS.has("HEAD")).toBe(false);
    expect(MUTATING_METHODS.has("OPTIONS")).toBe(false);
  });

  it("keeps the shared proxy and Worker header name stable", () => {
    expect(X_PHAROS_ADMIN_HEADER).toBe("X-Pharos-Admin");
  });
});
