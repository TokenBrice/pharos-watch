import { describe, expect, it } from "vitest";
import type { LiveReserveWarning } from "@shared/types/live-reserves";
import { catchAndWarn, redactUrlSecrets } from "../warnings";

describe("redactUrlSecrets", () => {
  it("redacts a plain apikey query param", () => {
    expect(redactUrlSecrets("https://api.example.com/v1?apikey=secret123")).toBe(
      "https://api.example.com/v1?apikey=REDACTED",
    );
  });

  it("redacts mixed-case secret param names", () => {
    const input =
      "fetched https://api.example.com/v1?ApiKey=abc and https://other.example.com/data?TOKEN=xyz now";
    expect(redactUrlSecrets(input)).toBe(
      "fetched https://api.example.com/v1?ApiKey=REDACTED and https://other.example.com/data?TOKEN=REDACTED now",
    );
  });

  it("redacts multiple secret params on a single URL", () => {
    expect(redactUrlSecrets("https://api.example.com/v1?apikey=a&token=b&foo=bar")).toBe(
      "https://api.example.com/v1?apikey=REDACTED&token=REDACTED&foo=bar",
    );
  });

  it("passes a non-URL string through unchanged", () => {
    const input = "no urls here, even apikey=secret should not be touched";
    expect(redactUrlSecrets(input)).toBe(input);
  });

  it("redacts api_key, auth, access_token, secret variants", () => {
    expect(
      redactUrlSecrets(
        "https://x.example.com/p?api_key=1&auth=2&access_token=3&secret=4&keep=ok",
      ),
    ).toBe(
      "https://x.example.com/p?api_key=REDACTED&auth=REDACTED&access_token=REDACTED&secret=REDACTED&keep=ok",
    );
  });
});

describe("catchAndWarn", () => {
  it("redacts URL secrets in the assembled warning message", async () => {
    const warnings: LiveReserveWarning[] = [];
    const failing = Promise.reject(
      new Error("HTTP 401 for https://api.example.com/v1?apikey=secret123"),
    );

    const result = await catchAndWarn(failing, "test/code", "primary fetch", warnings);

    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe(
      "primary fetch: HTTP 401 for https://api.example.com/v1?apikey=REDACTED",
    );
    expect(warnings[0]?.code).toBe("test/code");
    expect(warnings[0]?.severity).toBe("info");
  });
});
