import { describe, expect, it, vi } from "vitest";
import { rollbackPagesDeployment } from "../rollback-pages-deployment.mjs";

describe("rollbackPagesDeployment", () => {
  it("POSTs to the Cloudflare Pages rollback endpoint with the correct auth header and body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, result: { id: "dep-1" } }), { status: 200 }),
    );

    await rollbackPagesDeployment({
      accountId: "acc-1",
      apiToken: "token-1",
      projectName: "stablecoin-dashboard",
      deploymentId: "dep-1",
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc-1/pages/projects/stablecoin-dashboard/deployments/dep-1/rollback",
    );
    expect(init.method).toBe("POST");
    expect(init.headers["Authorization"]).toBe("Bearer token-1");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe("{}");
  });

  it("throws when the response is a non-2xx status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, errors: [{ message: "not found" }] }), { status: 404 }),
    );

    await expect(
      rollbackPagesDeployment({
        accountId: "acc-1",
        apiToken: "token-1",
        projectName: "stablecoin-dashboard",
        deploymentId: "dep-1",
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow(/404/);
  });

  it("throws when the response JSON indicates success=false even with a 200 status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, errors: [{ message: "deployment is not eligible for rollback" }] }), { status: 200 }),
    );

    await expect(
      rollbackPagesDeployment({
        accountId: "acc-1",
        apiToken: "token-1",
        projectName: "stablecoin-dashboard",
        deploymentId: "dep-1",
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow(/not eligible/);
  });

  it("throws when required parameters are missing", async () => {
    await expect(
      rollbackPagesDeployment({
        accountId: "",
        apiToken: "token-1",
        projectName: "stablecoin-dashboard",
        deploymentId: "dep-1",
      }),
    ).rejects.toThrow(/accountId/);
  });
});
