import { describe, expect, it, vi } from "vitest";
import { rollbackPagesDeployment } from "../rollback-pages-deployment.mjs";

const noRetry = { maxAttempts: 1, retryDelayMs: 0 };

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
      ...noRetry,
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
        ...noRetry,
      }),
    ).rejects.toThrow(/404/);
  });

  // Cloudflare's API can return HTTP 200 with `success: false` when the
  // deployment is structurally ineligible for rollback (e.g., already-rolled-back
  // target). Surface this as an error even though the status is OK.
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
        ...noRetry,
      }),
    ).rejects.toThrow(/not eligible/);
  });

  it("throws when a 2xx response has a malformed JSON body instead of silently returning null", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));

    await expect(
      rollbackPagesDeployment({
        accountId: "acc-1",
        apiToken: "token-1",
        projectName: "stablecoin-dashboard",
        deploymentId: "dep-1",
        fetchImpl: fetchMock,
        ...noRetry,
      }),
    ).rejects.toThrow(/unparseable body/);
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

  it("retries transient 5xx failures and eventually succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("upstream blip", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, result: { id: "dep-1" } }), { status: 200 }));

    const attempts: Array<{ attempt: number; error: unknown }> = [];
    const result = await rollbackPagesDeployment({
      accountId: "acc-1",
      apiToken: "token-1",
      projectName: "stablecoin-dashboard",
      deploymentId: "dep-1",
      fetchImpl: fetchMock,
      maxAttempts: 3,
      retryDelayMs: 0,
      onAttemptError: (attempt, error) => attempts.push({ attempt, error }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ id: "dep-1" });
    expect(attempts).toHaveLength(1);
    expect(attempts[0].attempt).toBe(1);
  });

  it("surfaces the final error after exhausting retries", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response("nope", { status: 500 })),
    );

    await expect(
      rollbackPagesDeployment({
        accountId: "acc-1",
        apiToken: "token-1",
        projectName: "stablecoin-dashboard",
        deploymentId: "dep-1",
        fetchImpl: fetchMock,
        maxAttempts: 3,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow(/500/);

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
