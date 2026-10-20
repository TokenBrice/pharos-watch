import { describe, expect, it } from "vitest";
import type { LiveReserveWarning } from "@shared/types/live-reserves";
import { catchAndWarn } from "../warnings";

describe("catchAndWarn", () => {
  it("redacts URL secrets in the assembled warning message", async () => {
    const warnings: LiveReserveWarning[] = [];
    const failing = Promise.reject(
      new Error("HTTP 401 for https://api.example.com/v1?apikey=secret123 and https://eth-mainnet.g.alchemy.com/v2/path-secret"),
    );

    const result = await catchAndWarn(failing, "test/code", "primary https://issuer.example.com/reserves", warnings);

    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe(
      "primary https://issuer.example.com/reserves: HTTP 401 for https://api.example.com/v1?apikey=[redacted] and https://eth-mainnet.g.alchemy.com/[redacted]",
    );
    expect(warnings[0]?.code).toBe("test/code");
    expect(warnings[0]?.severity).toBe("info");
    expect(warnings[0]?.effect).toBe("info");
  });
});
