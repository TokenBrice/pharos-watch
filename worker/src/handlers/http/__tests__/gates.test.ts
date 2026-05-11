import { afterEach, describe, expect, it, vi } from "vitest";

const { verifyAccessJwt } = vi.hoisted(() => ({
  verifyAccessJwt: vi.fn(),
}));

vi.mock("@shared/lib/cloudflare-access-jwt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@shared/lib/cloudflare-access-jwt")>();
  return { ...actual, verifyAccessJwt };
});

import { evaluateAccessGate } from "../gates";

function makeEnv() {
  return {
    CORS_ORIGIN: "https://pharos.watch",
    SITE_API_SHARED_SECRET: "site-secret",
    CF_ACCESS_OPS_API_AUD: "ops-aud",
    CF_ACCESS_TEAM_DOMAIN: "pharos-watch",
  };
}

describe("evaluateAccessGate", () => {
  afterEach(() => {
    verifyAccessJwt.mockReset();
  });

  it("preserves Access-authenticated ops-api admin routing", async () => {
    verifyAccessJwt.mockResolvedValueOnce(true);
    const request = new Request("https://ops-api.pharos.watch/api/status", {
      headers: { "Cf-Access-Jwt-Assertion": "valid-access-jwt" },
    });

    const result = await evaluateAccessGate(request, new URL(request.url), makeEnv() as never);

    expect(result.response).toBeNull();
    expect(result.isAdmin).toBe(true);
    expect(result.requestLane).toBeNull();
    expect(verifyAccessJwt).toHaveBeenCalledWith({
      token: "valid-access-jwt",
      aud: "ops-aud",
      teamDomain: "pharos-watch",
    });
  });

  it("denies site-api admin paths after a valid site-proxy credential", async () => {
    const request = new Request("https://site-api.pharos.watch/api/api-key-requests-admin?limit=1", {
      headers: { "X-Pharos-Site-Proxy-Secret": "site-secret" },
    });

    const result = await evaluateAccessGate(request, new URL(request.url), makeEnv() as never);

    expect(result.response?.status).toBe(404);
    expect(result.requestLane).toBe("site-api");
    expect(result.isSiteProxy).toBe(false);
  });
});
