import { describe, it, expect } from "vitest";
import { safeErrorMessage } from "../safe-error-message";

describe("safeErrorMessage", () => {
  it("formats Error instances with name and message", () => {
    expect(safeErrorMessage(new TypeError("oops"))).toBe("TypeError: oops");
  });

  it("returns string inputs sanitized", () => {
    expect(safeErrorMessage("simple message")).toBe("simple message");
  });

  it("returns 'Unknown error' for undefined", () => {
    expect(safeErrorMessage(undefined)).toBe("Unknown error");
  });

  it("returns 'Unknown error' for non-Error objects", () => {
    expect(safeErrorMessage({ random: "thing" })).toBe("Unknown error");
    expect(safeErrorMessage(null)).toBe("Unknown error");
    expect(safeErrorMessage(42)).toBe("Unknown error");
  });

  it("strips SQL fragments from Error messages", () => {
    const err = new Error("D1_ERROR: SELECT * FROM users WHERE id = 1");
    const safe = safeErrorMessage(err);
    expect(safe).not.toMatch(/SELECT/i);
    expect(safe).not.toMatch(/users/);
    expect(safe).toContain("[sql]");
  });

  it("strips INSERT/UPDATE/DELETE SQL fragments", () => {
    expect(safeErrorMessage(new Error("INSERT INTO secrets VALUES ('x')"))).toContain("[sql]");
    expect(safeErrorMessage(new Error("UPDATE accounts SET balance = 0"))).toContain("[sql]");
    expect(safeErrorMessage(new Error("DELETE FROM logs"))).toContain("[sql]");
  });

  it("strips email-like content from Error messages", () => {
    const err = new Error("failed to send to alice.smith+test@example.com today");
    const safe = safeErrorMessage(err);
    expect(safe).not.toContain("alice");
    expect(safe).not.toContain("example.com");
    expect(safe).toContain("[email]");
  });

  it("strips URLs from messages", () => {
    const safe = safeErrorMessage(new Error("fetch failed for https://api.example.com/v1/secret?token=abc"));
    expect(safe).not.toContain("example.com");
    expect(safe).toContain("[url]");
  });

  it("truncates messages longer than maxLength", () => {
    const long = "x".repeat(500);
    const safe = safeErrorMessage(new Error(long), 50);
    // Error name prefix + 50-char body + ellipsis.
    expect(safe.length).toBeLessThanOrEqual("Error: ".length + 51);
    expect(safe.endsWith("…")).toBe(true);
  });

  it("truncates raw string inputs", () => {
    expect(safeErrorMessage("a".repeat(300), 10)).toBe(`${"a".repeat(10)}…`);
  });
});
