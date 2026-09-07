import { DONOR_KEY_CLAIMS_OPEN } from "@shared/lib/public-api-contract";
import { describe, expect, it } from "vitest";
import { makeJsonRequest, readJsonResponse } from "../../test-helpers/__shared/auth";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { handleDonorKeyClaim } from "../donor-key-claims";

describe("donor key claim switch", () => {
  it.skipIf(DONOR_KEY_CLAIMS_OPEN)("rejects claims before touching the limiter or the body while paused", async () => {
    const response = await handleDonorKeyClaim(
      makeNoopD1() as unknown as D1Database,
      makeJsonRequest("https://api.pharos.watch/api/donor-key-claims", { message: "x", signature: "0x" }),
      {
        rateLimiter: {
          limit: async () => {
            throw new Error("rate limiter must not run while claims are paused");
          },
        },
        pepper: undefined,
      },
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect((await readJsonResponse<{ error: string }>(response, 403)).error).toMatch(/claims are paused/);
  });
});
