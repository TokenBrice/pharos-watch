import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseCronDeliveryArgs, readCronDelivery } from "../cron-delivery.mjs";

const row = { datetime: "2026-10-06T20:01:00Z", scheduledDatetime: "2026-10-06T20:01:00Z", cron: "1,6 * * * *", status: "success", cpuTimeUs: 1000 };
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
const payload = (rows: unknown[]) => ({ data: { viewer: { accounts: [{ workersInvocationsScheduled: rows }] } } });
const scriptPath = resolve("scripts/maintenance/cron-delivery.mjs");

describe("cron-delivery read-only CLI", () => {
  it("uses strict options and bounded windows", () => {
    expect(parseCronDeliveryArgs([])).toEqual({ minutes: 120, raw: false });
    expect(parseCronDeliveryArgs(["--minutes", "240", "--raw"])).toEqual({ minutes: 240, raw: true });
    expect(parseCronDeliveryArgs(["--help"])).toEqual({ help: true });
    for (const args of [["120"], ["--other"], ["--minutes", "0"], ["--minutes", "1441"], ["--minutes", "2.5"], ["--raw", "--raw"]]) expect(() => parseCronDeliveryArgs(args)).toThrow();
  });
  it("requires environment token before any transport", async () => {
    const fetchImpl = vi.fn();
    await expect(readCronDelivery({ token: undefined, fetchImpl })).rejects.toThrow("CLOUDFLARE_API_TOKEN");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("returns validated platform rows without mutation endpoints", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(payload([row])));
    const result = await readCronDelivery({ token: "test-only", now: new Date("2026-10-06T21:00:00Z"), fetchImpl });
    expect(result.rows).toEqual([row]);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).query).not.toContain("mutation");
    expect(result.from).toBe("2026-10-06T19:00:00.000Z");
  });
  it.each([
    ["HTTP", () => response({}, 403)],
    ["GraphQL", () => response({ errors: [{ message: "denied" }], ...payload([]) })],
    ["account", () => response({ data: { viewer: { accounts: [] } } })],
    ["row", () => response(payload([{ ...row, cpuTimeUs: null }]))],
    ["truncation", () => response(payload(Array.from({ length: 10000 }, () => row)))],
    ["JSON", () => new Response("not-json")],
  ])("rejects %s evidence failures", async (_label, makeResponse) => {
    await expect(readCronDelivery({ token: "test-only", fetchImpl: vi.fn().mockResolvedValue(makeResponse()) })).rejects.toThrow();
  });
  it("propagates transport failure and keeps empty evidence distinct", async () => {
    await expect(readCronDelivery({ token: "test-only", fetchImpl: vi.fn().mockRejectedValue(new Error("network")) })).rejects.toThrow("network");
    expect((await readCronDelivery({ token: "test-only", fetchImpl: vi.fn().mockResolvedValue(response(payload([]))) })).rows).toEqual([]);
  });
});
describe("scheduled delivery operator target", () => {
  it.each([undefined, "stablecoin-heavy"])("uses and prints the selected script (%s)", (workerName) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CLOUDFLARE_API_TOKEN: "test-analytics-token" };
    delete env.CLOUDFLARE_WORKER_NAME;
    if (workerName) env.CLOUDFLARE_WORKER_NAME = workerName;
    const expected = workerName ?? "stablecoin-api";
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      process.argv.splice(1, process.argv.length - 1, ${JSON.stringify(scriptPath)}, '--minutes', '240');
      globalThis.fetch = async (_url, init) => {
        const request = JSON.parse(init.body);
        if (request.variables.s !== ${JSON.stringify(expected)}) throw new Error('Wrong Analytics script target');
        if (Date.parse(request.variables.t) - Date.parse(request.variables.f) !== 240 * 60000) throw new Error('Wrong window');
        return { ok: true, json: async () => ({ data: { viewer: { accounts: [{ workersInvocationsScheduled: [] }] } } }) };
      };
      // Load the CLI only after installing argv and fetch mocks to exercise its direct-run boundary.
      await import(${JSON.stringify(pathToFileURL(scriptPath).href)});
    `], { env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`script=${expected} rows=0 window=`);
    expect(result.stdout).toContain("absence is not a success claim");
    expect(result.stdout).not.toContain("test-analytics-token");
  });
});
