import { describe, expect, it, vi } from "vitest";
import { parseCronDeliveryArgs, readCronDelivery } from "../cron-delivery.mjs";

const row = { datetime: "2026-10-06T20:01:00Z", scheduledDatetime: "2026-10-06T20:01:00Z", cron: "1,6 * * * *", status: "success", cpuTimeUs: 1000 };
function response(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
const payload = (rows: unknown[]) => ({ data: { viewer: { accounts: [{ workersInvocationsScheduled: rows }] } } });

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
