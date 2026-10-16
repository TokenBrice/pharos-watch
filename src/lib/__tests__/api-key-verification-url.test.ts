// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { stripQueryVerificationTokenFromUrl } from "../api-key-verification-url";

beforeEach(() => {
  window.history.replaceState(null, "", "/api/");
});

describe("API-key verification URL handling", () => {
  it("removes legacy query tokens while preserving attribution and the hash", () => {
    window.history.replaceState(null, "", "/api/?verify=secret&utm_source=email#section");

    stripQueryVerificationTokenFromUrl();

    expect(window.location.pathname).toBe("/api/");
    expect(window.location.search).toBe("?utm_source=email");
    expect(window.location.hash).toBe("#section");
  });

  it("removes every verify query parameter while preserving an unrelated fragment", () => {
    window.history.replaceState(null, "", "/api/?verify=first&verify=second&utm_source=email#section");

    stripQueryVerificationTokenFromUrl();

    expect(window.location.search).toBe("?utm_source=email");
    expect(window.location.hash).toBe("#section");
  });
});
