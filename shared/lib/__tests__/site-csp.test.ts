import { describe, expect, it } from "vitest";
import { addNonceToInlineScripts } from "../site-csp";

describe("site CSP helpers", () => {
  it("adds a nonce to inline script tags", () => {
    expect(addNonceToInlineScripts("<script>1</script>", "abc123")).toBe(
      '<script nonce="abc123">1</script>',
    );
  });

  it("replaces stale inline script nonces", () => {
    expect(addNonceToInlineScripts('<script nonce="old">1</script>', "abc123")).toBe(
      '<script nonce="abc123">1</script>',
    );
  });

  it("replaces empty inline script nonces", () => {
    expect(addNonceToInlineScripts('<script nonce="">1</script>', "abc123")).toBe(
      '<script nonce="abc123">1</script>',
    );
  });

  it("leaves external script tags unchanged", () => {
    expect(addNonceToInlineScripts('<script src="/app.js"></script>', "abc123")).toBe(
      '<script src="/app.js"></script>',
    );
  });
});
