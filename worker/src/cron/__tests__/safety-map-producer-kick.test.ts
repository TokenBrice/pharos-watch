import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import {
  SAFETY_MAP_KICK_MAX_DISPATCHES,
  runSafetyMapProducerKick,
} from "../safety-map-producer-kick";

const DATE = "2026-09-29";
const MANIFEST_URL = "https://pharos.watch/safety-scores/map.json";
const DISPATCH_URL =
  "https://api.github.com/repos/TokenBrice/pharos-watch/actions/workflows/safety-map-refresh.yml/dispatches";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  fixtures.closeAll();
  vi.unstubAllGlobals();
});

function at(time: string, date = DATE): number {
  return Math.floor(Date.parse(`${date}T${time}Z`) / 1_000);
}

interface FetchScript {
  manifest: () => Response;
  dispatch?: () => Response;
}

function stubFetch(script: FetchScript) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === MANIFEST_URL) return script.manifest();
    if (url === DISPATCH_URL && script.dispatch) return script.dispatch();
    throw new Error(`unexpected fetch ${url}`);
  }));
  return {
    calls,
    dispatches: () => calls.filter((call) => call.url === DISPATCH_URL),
  };
}

const manifestFor = (date: string) => () => new Response(JSON.stringify({ date }), {
  status: 200,
  headers: { "Content-Type": "application/json" },
});
const accepted = () => new Response(null, { status: 204 });

describe("safety map producer kick", () => {
  it("makes no request outside the pre-digest window", async () => {
    const { db } = fixtures.open();
    const fetchLog = stubFetch({ manifest: manifestFor("2026-09-27"), dispatch: accepted });

    for (const time of ["06:15:00", "08:00:00", "12:00:00"]) {
      const result = await runSafetyMapProducerKick({ db, nowSec: at(time), githubToken: "token" });
      expect(result).toMatchObject({ action: "outside-window", outcome: null });
    }
    expect(fetchLog.calls).toEqual([]);
  });

  it("leaves a live same-day map alone", async () => {
    const { db } = fixtures.open();
    const fetchLog = stubFetch({ manifest: manifestFor(DATE), dispatch: accepted });

    const result = await runSafetyMapProducerKick({ db, nowSec: at("06:20:00"), githubToken: "token" });

    expect(result).toMatchObject({ action: "current", outcome: "ok", manifestDate: DATE, dispatches: 0 });
    expect(fetchLog.dispatches()).toEqual([]);
  });

  it("dispatches the workflow in ensure mode when the manifest is not today's", async () => {
    const { db } = fixtures.open();
    const fetchLog = stubFetch({ manifest: manifestFor("2026-09-28"), dispatch: accepted });

    const result = await runSafetyMapProducerKick({ db, nowSec: at("06:20:00"), githubToken: " token " });

    expect(result).toMatchObject({ action: "dispatched", outcome: "ok", manifestDate: "2026-09-28", dispatches: 1 });
    const [dispatch] = fetchLog.dispatches();
    expect(dispatch?.init?.method).toBe("POST");
    expect(JSON.parse(String(dispatch?.init?.body))).toEqual({ ref: "main", inputs: { mode: "ensure" } });
    expect(new Headers(dispatch?.init?.headers).get("Authorization")).toBe("Bearer token");
  });

  it("treats an unreadable manifest as missing rather than as published", async () => {
    const { db } = fixtures.open();
    const fetchLog = stubFetch({ manifest: () => new Response("unavailable", { status: 503 }), dispatch: accepted });

    const result = await runSafetyMapProducerKick({ db, nowSec: at("06:20:00"), githubToken: "token" });

    expect(result).toMatchObject({ action: "dispatched", manifestDate: null, manifestReason: "manifest-http-503" });
    expect(fetchLog.dispatches()).toHaveLength(1);
  });

  it("spaces dispatches and stops at the daily cap", async () => {
    const { db } = fixtures.open();
    const fetchLog = stubFetch({ manifest: manifestFor("2026-09-28"), dispatch: accepted });
    const actions: string[] = [];
    for (let minute = 20; minute < 60; minute += 5) {
      const result = await runSafetyMapProducerKick({ db, nowSec: at(`06:${minute}:00`), githubToken: "token" });
      actions.push(result.action);
    }
    const exhausted = await runSafetyMapProducerKick({ db, nowSec: at("07:55:00"), githubToken: "token" });

    expect(actions).toEqual([
      "dispatched", "awaiting-render", "awaiting-render",
      "dispatched", "awaiting-render", "awaiting-render",
      "dispatched", "attempts-exhausted",
    ]);
    expect(exhausted).toMatchObject({
      action: "attempts-exhausted",
      outcome: "degraded",
      dispatches: SAFETY_MAP_KICK_MAX_DISPATCHES,
    });
    expect(fetchLog.dispatches()).toHaveLength(SAFETY_MAP_KICK_MAX_DISPATCHES);
  });

  it("starts a fresh attempt budget on a new UTC day", async () => {
    const { db } = fixtures.open();
    stubFetch({ manifest: manifestFor("2026-09-27"), dispatch: accepted });
    for (const time of ["06:20:00", "06:35:00", "06:50:00"]) {
      await runSafetyMapProducerKick({ db, nowSec: at(time), githubToken: "token" });
    }

    const nextDay = await runSafetyMapProducerKick({ db, nowSec: at("06:20:00", "2026-09-30"), githubToken: "token" });

    expect(nextDay).toMatchObject({ action: "dispatched", date: "2026-09-30", dispatches: 1 });
  });

  it("counts a rejected dispatch against the budget and reports the GitHub status", async () => {
    const { db } = fixtures.open();
    const fetchLog = stubFetch({
      manifest: manifestFor("2026-09-28"),
      dispatch: () => new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), { status: 403 }),
    });

    const rejected = await runSafetyMapProducerKick({ db, nowSec: at("06:20:00"), githubToken: "token" });
    const retry = await runSafetyMapProducerKick({ db, nowSec: at("06:25:00"), githubToken: "token" });

    expect(rejected).toMatchObject({ action: "dispatch-failed", outcome: "degraded", dispatches: 1 });
    expect(rejected.error).toMatch(/^dispatch-http-403: .*Resource not accessible/);
    expect(retry.action).toBe("awaiting-render");
    expect(fetchLog.dispatches()).toHaveLength(1);
  });

  it("reports a missing token as degraded without dispatching", async () => {
    const { db } = fixtures.open();
    const fetchLog = stubFetch({ manifest: manifestFor("2026-09-28"), dispatch: accepted });

    const result = await runSafetyMapProducerKick({ db, nowSec: at("06:20:00"), githubToken: "  " });

    expect(result).toMatchObject({ action: "token-missing", outcome: "degraded" });
    expect(fetchLog.dispatches()).toEqual([]);
  });
});
