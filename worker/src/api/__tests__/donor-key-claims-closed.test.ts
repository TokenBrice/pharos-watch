import { describe, expect, it, vi } from "vitest";
import { makeJsonRequest, readJsonResponse } from "../../test-helpers/__shared/auth";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { handleDonorKeyClaim } from "../donor-key-claims";

vi.mock("@shared/lib/public-api-contract", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shared/lib/public-api-contract")>()),
  DONOR_KEY_CLAIMS_OPEN: false,
}));

describe("donor key claim switch", () => {
  it("rejects claims before touching the limiter or the body while paused", async () => {
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
