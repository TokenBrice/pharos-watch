import { describe, expect, it } from "vitest";
import { SELF_SERVE_ISSUANCE_OPEN } from "@shared/lib/public-api-contract";
import { makeJsonRequest, readJsonResponse } from "../../test-helpers/__shared/auth";
import { makeNoopD1 } from "../../test-helpers/noop-d1";
import { handleApiKeyRequest } from "../api-key-requests";

describe("self-serve issuance switch", () => {
  it.skipIf(SELF_SERVE_ISSUANCE_OPEN)("rejects submissions before touching D1 or env while closed", async () => {
    const response = await handleApiKeyRequest(
      makeNoopD1() as unknown as D1Database,
      makeJsonRequest("https://api.pharos.watch/api/api-key-requests", { email: "a@b.co" }),
      {},
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect((await readJsonResponse<{ error: string }>(response, 403)).error).toMatch(/issuance is closed/);
  });
});
