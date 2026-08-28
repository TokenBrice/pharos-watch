import { describe, expect, it } from "vitest";
import {
  buildAdminJobSummary,
  noAdminTargetsResponse,
  readAdminIntegerParam,
  readAdminStringParam,
  runAdminJob,
} from "../admin-job";

describe("admin-job helpers", () => {
  it("executes jobs without owning route authentication", async () => {
    const response = await runAdminJob(
      {
        request: new Request("https://api.pharos.watch/api/admin"),
        url: new URL("https://api.pharos.watch/api/admin"),
      },
      async () => new Response("ok"),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
  });

  it("parses body payloads and computes dryRun from body or query", async () => {
    const response = await runAdminJob(
      {
        request: new Request("https://api.pharos.watch/api/admin?dry-run=false", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Pharos-Admin": "1" },
          body: JSON.stringify({ dryRun: true, configKey: " usdc " }),
        }),
        url: new URL("https://api.pharos.watch/api/admin?dry-run=false"),
        parseBody: true,
      },
      async ({ body, dryRun }) => Response.json({ body, dryRun }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      body: { dryRun: true, configKey: " usdc " },
      dryRun: true,
    });
  });

  it("returns body parse errors from malformed admin JSON", async () => {
    const response = await runAdminJob(
      {
        request: new Request("https://api.pharos.watch/api/admin", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Pharos-Admin": "1" },
          body: "{",
        }),
        url: new URL("https://api.pharos.watch/api/admin"),
        parseBody: true,
      },
      async () => new Response("ok"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
  });

  it("prefers body values over query params for string and integer helpers", () => {
    const params = new URLSearchParams("configKey=usdt&chunkSize=20");
    const body = { configKey: " usdc ", chunkSize: 12 };

    expect(readAdminStringParam(body, params, "configKey")).toBe("usdc");
    expect(readAdminIntegerParam(body, params, "chunkSize")).toBe(12);
  });

  it("falls back to query params and ignores invalid integer queries", () => {
    expect(readAdminStringParam({}, new URLSearchParams("configKey= dai "), "configKey")).toBe("dai");
    expect(readAdminIntegerParam({}, new URLSearchParams("chunkSize=25"), "chunkSize")).toBe(25);
    expect(readAdminIntegerParam({}, new URLSearchParams("chunkSize=2.5"), "chunkSize")).toBeNull();
  });

  it("omits empty arrays from shared admin job summaries", () => {
    expect(buildAdminJobSummary({ updated: 4, skipped: [], errors: [], preserved: ["usdc"] })).toEqual({
      updated: 4,
      preserved: ["usdc"],
    });
  });

  it("returns the canonical no-targets response shape", async () => {
    const response = noAdminTargetsResponse();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ message: "No coins in this batch" });
  });
});
