import { describe, expect, it } from "vitest";
import { summarizeFetchError } from "../proxy-utils";

describe("summarizeFetchError", () => {
  it("preserves Error and DOMException names while using shared messages", () => {
    expect(summarizeFetchError(new Error("network down"))).toEqual({
      kind: "Error",
      message: "network down",
    });
    expect(summarizeFetchError(new DOMException("request timed out", "TimeoutError"))).toEqual({
      kind: "TimeoutError",
      message: "request timed out",
    });
  });

  it("stringifies non-Error values", () => {
    expect(summarizeFetchError("network down")).toEqual({ kind: "string", message: "network down" });
    expect(summarizeFetchError(null)).toEqual({ kind: "object", message: "null" });
    expect(summarizeFetchError({ message: "network down" })).toEqual({
      kind: "object",
      message: "[object Object]",
    });
    expect(summarizeFetchError({})).toEqual({ kind: "object", message: "[object Object]" });
  });
});
