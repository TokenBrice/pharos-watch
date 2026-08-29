import { describe, expect, it } from "vitest";
import { toErrorMessage } from "../error-utils";

describe("toErrorMessage", () => {
  it("uses Error and DOMException messages", () => {
    expect(toErrorMessage(new Error("error message"))).toBe("error message");
    expect(toErrorMessage(new DOMException("abort message", "AbortError"))).toBe("abort message");
  });

  it("stringifies non-Error values, including objects with message-like fields", () => {
    expect(toErrorMessage("string message")).toBe("string message");
    expect(toErrorMessage(null)).toBe("null");
    expect(toErrorMessage({ message: "object message" })).toBe("[object Object]");
    expect(toErrorMessage({})).toBe("[object Object]");
  });
});
