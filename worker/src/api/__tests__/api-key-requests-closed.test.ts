import { afterEach, describe, expect, it, vi } from "vitest";
import { makeJsonRequest, readJsonResponse } from "../../test-helpers/__shared/auth";
import { handleApiKeyRequest } from "../api-key-requests";

vi.mock("@shared/lib/public-api-contract", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@shared/lib/public-api-contract")>()),
  SELF_SERVE_ISSUANCE_OPEN: false,
}));

afterEach(() => vi.unstubAllGlobals());

describe("self-serve issuance switch", () => {
  it("rejects submissions before touching D1 or env while closed", async () => {
    const fetchSpy = vi.fn(() => { throw new Error("Unexpected provider activity"); });
    vi.stubGlobal("fetch", fetchSpy);
    const db = new Proxy({} as D1Database, {
      get() { throw new Error("Closed issuance accessed D1"); },
    });
    const response = await handleApiKeyRequest(
      db,
      makeJsonRequest("https://api.pharos.watch/api/api-key-requests", { email: "a@b.co" }),
      new Proxy({}, { get() { throw new Error("Closed issuance accessed env"); } }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect((await readJsonResponse<{ error: string }>(response, 403)).error).toMatch(/issuance is closed/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
