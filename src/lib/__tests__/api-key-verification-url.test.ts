// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readVerificationTokenFromUrl,
  stripQueryVerificationTokenFromUrl,
  stripVerificationTokenFromUrl,
} from "../api-key-verification-url";

beforeEach(() => {
  window.history.replaceState(null, "", "/api/");
  window.sessionStorage.clear();
});

const SESSION_KEY = "pharos:api-key-verify-token";
const ORIGINAL_SESSION_STORAGE = Object.getOwnPropertyDescriptor(window, "sessionStorage");

afterEach(() => {
  // Restore the stubbed window before touching its descriptors.
  vi.unstubAllGlobals();
  if (ORIGINAL_SESSION_STORAGE) {
    Object.defineProperty(window, "sessionStorage", ORIGINAL_SESSION_STORAGE);
  }
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

  it("rejects a malformed percent-encoded hash token instead of decoding it", () => {
    window.history.replaceState(null, "", "/api/#akv_%E0%A4%A");

    expect(readVerificationTokenFromUrl()).toBeNull();
  });

  it("prefers the hash token and keeps the stored token available for a later read", () => {
    window.sessionStorage.setItem(SESSION_KEY, "akv_session");
    window.history.replaceState(null, "", "/api/#akv_hash");

    expect(readVerificationTokenFromUrl()).toBe("akv_hash");

    stripVerificationTokenFromUrl();
    expect(window.location.hash).toBe("");
    expect(readVerificationTokenFromUrl()).toBe("akv_session");
    expect(readVerificationTokenFromUrl()).toBeNull();
  });

  it("returns no token when privacy-restricted storage access throws", () => {
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new DOMException("storage disabled", "SecurityError");
      },
    });

    expect(readVerificationTokenFromUrl()).toBeNull();
  });

  it("removes every verify query parameter while preserving an unrelated fragment", () => {
    window.history.replaceState(null, "", "/api/?verify=first&verify=second&utm_source=email#section");

    stripVerificationTokenFromUrl();

    expect(window.location.search).toBe("?utm_source=email");
    expect(window.location.hash).toBe("#section");
  });

  it("reads no token and performs no scrubbing without a window", () => {
    vi.stubGlobal("window", undefined);

    expect(readVerificationTokenFromUrl()).toBeNull();
    expect(stripQueryVerificationTokenFromUrl()).toBeUndefined();
    expect(stripVerificationTokenFromUrl()).toBeUndefined();
  });
});
