import { describe, it, expect } from "vitest";
import { redactProviderUrls, safeErrorMessage, stripSensitive } from "../safe-error-message";

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

  it("does not coerce non-Error objects while sanitizing", () => {
    const value = {
      toString() {
        throw new Error("should not be called");
      },
    };
    expect(safeErrorMessage(value)).toBe("Unknown error");
    expect(safeErrorMessage(Object.create(null))).toBe("Unknown error");
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

  it("redacts API-key-bearing provider URLs while preserving host context", () => {
    expect(
      redactProviderUrls("rpc https://eth-mainnet.g.alchemy.com/v2/super-secret-key failed"),
    ).toBe("rpc https://eth-mainnet.g.alchemy.com/[redacted] failed");
    expect(
      redactProviderUrls("telegram https://api.telegram.org/bot123456:token/sendMessage failed"),
    ).toBe("telegram https://api.telegram.org/[redacted] failed");
    expect(
      redactProviderUrls("etherscan https://api.etherscan.io/v2/api?chainid=1&apikey=secret&module=logs failed"),
    ).toBe("etherscan https://api.etherscan.io/[redacted] failed");
    expect(
      redactProviderUrls("generic https://example.com/v1/path?token=secret&ok=1 failed"),
    ).toBe("generic https://example.com/v1/path?token=[redacted]&ok=1 failed");
    expect(
      redactProviderUrls("oxr https://openexchangerates.org/api/latest.json?app_id=secret&symbols=EUR&base=USD failed"),
    ).toBe("oxr https://openexchangerates.org/api/latest.json?app_id=[redacted]&symbols=EUR&base=USD failed");
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

describe("stripSensitive email redaction linearity", () => {
  it("survives an 80,000-character local-part run in linear time", () => {
    const run = "a".repeat(80_000);
    const startedAt = Date.now();
    const safe = safeErrorMessage(new Error(run));
    const elapsedMs = Date.now() - startedAt;
    // The unanchored pattern this replaced backtracked quadratically and took
    // ~3s on this input; the anchored scan is ~1ms. 500ms still fails a
    // reintroduced quadratic scan on the slowest CI runner while leaving two
    // orders of magnitude of headroom for the linear path.
    expect(elapsedMs).toBeLessThan(500);
    expect(safe.length).toBeLessThanOrEqual("Error: ".length + 201);
  });

  it("still redacts an address glued to the end of a long run", () => {
    // The 80k run and "user" form one local part, so the whole string is one
    // address from the run's first character.
    expect(stripSensitive(`${"a".repeat(79_990)}user@example.com`)).toBe("[email]");
  });

  it("still redacts an address that follows a long run", () => {
    expect(stripSensitive(`${"a".repeat(80_000)} user@example.com`))
      .toBe(`${"a".repeat(80_000)} [email]`);
  });

  it("redacts both addresses of a '+'-glued pair like the unanchored scan", () => {
    // A match can end on '+' (a local-part character the domain tail never
    // consumes) and the next address starts exactly there; the anchored scan
    // must not leave the second address visible.
    expect(stripSensitive("foo@bar.co+alice@evil.com")).toBe("[email][email]");
    expect(stripSensitive("foo@bar.co+alice@evil.com+bob@mall.org")).toBe("[email][email][email]");
  });
});
