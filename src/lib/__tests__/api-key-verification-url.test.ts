// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  readVerificationTokenFromUrl,
  stripQueryVerificationTokenFromUrl,
  stripVerificationTokenFromUrl,
} from "../api-key-verification-url";

beforeEach(() => {
  window.history.replaceState(null, "", "/api/");
  window.sessionStorage.clear();
});

describe("API-key verification URL handling", () => {
  it("removes legacy query tokens while preserving attribution and the hash", () => {
    window.history.replaceState(null, "", "/api/?verify=secret&utm_source=email#section");

    stripQueryVerificationTokenFromUrl();

    expect(window.location.pathname).toBe("/api/");
    expect(window.location.search).toBe("?utm_source=email");
    expect(window.location.hash).toBe("#section");
  });

  it("consumes hash verification tokens and scrubs every token-bearing URL part", () => {
    window.history.replaceState(null, "", "/api/?verify=legacy&utm_source=email#akv_token%20");

    expect(readVerificationTokenFromUrl()).toBe("akv_token");
    stripVerificationTokenFromUrl();

    expect(window.location.href).not.toContain("verify=");
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("?utm_source=email");
  });

  it("consumes a session-stored token when privacy-safe URL delivery omitted the hash", () => {
    window.sessionStorage.setItem("pharos:api-key-verify-token", "akv_session");

    expect(readVerificationTokenFromUrl()).toBe("akv_session");
    expect(readVerificationTokenFromUrl()).toBeNull();
  });

  it("keeps the global URL scrubber free of schema-bearing imports", () => {
    const source = readFileSync("src/lib/api-key-verification-url.ts", "utf8");

    expect(source).not.toMatch(/from ["']zod|@shared\/types|api-key-self-serve/);
  });
});
