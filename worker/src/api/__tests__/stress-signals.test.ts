import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleStressSignals } from "../stress-signals";
import {
  StressSignalsAllResponseSchema,
  StressSignalDetailResponseSchema,
} from "@shared/types/market";

const nowSec = Math.floor(Date.now() / 1000);

const signalsJson = JSON.stringify({
  supply: { value: 10, available: true },
  price: { value: 5, available: true },
});

describe("handleStressSignals contract tests", () => {
  it("aggregate mode returns shape matching StressSignalsAllResponseSchema", async () => {
    const db = mockD1([
      {
        match: "stress_signals",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            score: 12,
            band: "CALM",
            signals_json: signalsJson,
            computed_at: nowSec,
          },
        ],
      },
    ]);

    const url = new URL("https://x/api/stress-signals");
    const res = await handleStressSignals(db, url);

    expect(res.status).toBe(200);
    const json = await res.json();

    const parsed = StressSignalsAllResponseSchema.safeParse(json);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error("StressSignalsAllResponseSchema parse failed");
    }
    const body = parsed.data;
    expect(body).toHaveProperty("signals");
    expect(body).toHaveProperty("updatedAt");
    expect(body).toHaveProperty("methodology");
    expect(body.signals["usdt-tether"]).toHaveProperty("methodologyVersion");
  });

  it("single-coin mode returns shape matching StressSignalDetailResponseSchema", async () => {
    const db = mockD1([
      {
        match: "stress_signals",
        rows: [],
        first: {
          score: 25,
          band: "WATCH",
          signals_json: signalsJson,
          computed_at: nowSec,
        },
      },
      {
        match: "stress_signal_history",
        rows: [
          {
            snapshot_date: nowSec - 86400,
            score: 20,
            band: "WATCH",
            signals_json: signalsJson,
          },
        ],
      },
    ]);

    const url = new URL("https://x/api/stress-signals?stablecoin=usdt-tether&days=7");
    const res = await handleStressSignals(db, url);

    expect(res.status).toBe(200);
    const json = await res.json();

    const parsed = StressSignalDetailResponseSchema.safeParse(json);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error("StressSignalDetailResponseSchema parse failed");
    }
    const body = parsed.data;
    expect(body).toHaveProperty("current");
    expect(body).toHaveProperty("history");
    expect(body).toHaveProperty("methodology");
    expect(body.current).toHaveProperty("methodologyVersion");
    expect(body.history[0]).toHaveProperty("methodologyVersion");
  });

  it("rejects unknown stablecoin ID with 404", async () => {
    const db = mockD1();
    const url = new URL("https://x/api/stress-signals?stablecoin=../etc/passwd");
    const res = await handleStressSignals(db, url);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Unknown");
  });

  it("rejects untracked stablecoin ID with 404", async () => {
    const db = mockD1();
    const url = new URL("https://x/api/stress-signals?stablecoin=ust-terra&days=7");
    const res = await handleStressSignals(db, url);

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("not tracked");
  });

  it("skips malformed rows instead of failing the whole response", async () => {
    const db = mockD1([
      {
        match: "stress_signals",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            score: 12,
            band: "CALM",
            signals_json: signalsJson,
            computed_at: nowSec,
          },
          {
            stablecoin_id: "usdc-circle",
            score: 40,
            band: "WATCH",
            signals_json: "{invalid-json",
            computed_at: nowSec,
          },
        ],
      },
    ]);

    const res = await handleStressSignals(db, new URL("https://x/api/stress-signals"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      signals: Record<string, unknown>;
      malformedRows: number;
    };
    expect(body.signals).toHaveProperty("usdt-tether");
    expect(body.signals).not.toHaveProperty("usdc-circle");
    expect(body.malformedRows).toBe(1);
  });

  it("filters out untracked IDs from aggregate responses", async () => {
    const db = mockD1([
      {
        match: "stress_signals",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            score: 12,
            band: "CALM",
            signals_json: signalsJson,
            computed_at: nowSec,
          },
          {
            stablecoin_id: "999999999",
            score: 65,
            band: "ALERT",
            signals_json: signalsJson,
            computed_at: nowSec,
          },
        ],
      },
    ]);

    const res = await handleStressSignals(db, new URL("https://x/api/stress-signals"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      signals: Record<string, unknown>;
    };
    expect(body.signals).toHaveProperty("usdt-tether");
    expect(body.signals).not.toHaveProperty("999999999");
  });

  it("includes amplifiers (psi + contagion) on aggregate entries, unwrapping the wrapped payload", async () => {
    const wrappedJson = JSON.stringify({
      signals: {
        supply: { value: 10, available: true },
        pool: { value: 20, available: true },
      },
      amplifiers: { psi: 1.08, contagion: 1.15 },
    });
    const db = mockD1([
      {
        match: "stress_signals",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            score: 42,
            band: "ALERT",
            signals_json: wrappedJson,
            computed_at: nowSec,
          },
        ],
      },
    ]);

    const res = await handleStressSignals(db, new URL("https://x/api/stress-signals"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      signals: Record<string, {
        signals: Record<string, unknown>;
        amplifiers: { psi: number; contagion: number };
      }>;
    };
    const entry = body.signals["usdt-tether"];
    expect(entry.amplifiers).toEqual({ psi: 1.08, contagion: 1.15 });
    // signals map is unwrapped — no leftover envelope keys.
    expect(entry.signals).toEqual({
      supply: { value: 10, available: true },
      pool: { value: 20, available: true },
    });
  });

  it("defaults amplifiers to {psi:1,contagion:1} for legacy flat-shape rows", async () => {
    const legacyJson = JSON.stringify({
      supply: { value: 10, available: true },
    });
    const db = mockD1([
      {
        match: "stress_signals",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            score: 12,
            band: "CALM",
            signals_json: legacyJson,
            computed_at: nowSec,
          },
        ],
      },
    ]);

    const res = await handleStressSignals(db, new URL("https://x/api/stress-signals"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      signals: Record<string, { amplifiers: { psi: number; contagion: number } }>;
    };
    expect(body.signals["usdt-tether"].amplifiers).toEqual({ psi: 1, contagion: 1 });
  });

  it("includes amplifiers on the single-coin endpoint, unwrapping both current and history rows", async () => {
    const wrappedJson = JSON.stringify({
      signals: { supply: { value: 5, available: true } },
      amplifiers: { psi: 1.05, contagion: 1.2 },
    });
    const legacyJson = JSON.stringify({ supply: { value: 5, available: true } });
    const db = mockD1([
      {
        match: "stress_signals",
        rows: [],
        first: {
          score: 25,
          band: "WATCH",
          signals_json: wrappedJson,
          computed_at: nowSec,
        },
      },
      {
        match: "stress_signal_history",
        rows: [
          {
            snapshot_date: nowSec - 86400,
            score: 20,
            band: "WATCH",
            signals_json: legacyJson,
          },
          {
            snapshot_date: nowSec - 172800,
            score: 22,
            band: "WATCH",
            signals_json: wrappedJson,
          },
        ],
      },
    ]);

    const res = await handleStressSignals(
      db,
      new URL("https://x/api/stress-signals?stablecoin=usdt-tether&days=7"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      current: { amplifiers: { psi: number; contagion: number }; signals: Record<string, unknown> } | null;
      history: { amplifiers: { psi: number; contagion: number }; signals: Record<string, unknown> }[];
    };
    expect(body.current?.amplifiers).toEqual({ psi: 1.05, contagion: 1.2 });
    expect(body.current?.signals).toEqual({ supply: { value: 5, available: true } });
    // history[0] legacy flat row defaults to {1,1}
    expect(body.history[0].amplifiers).toEqual({ psi: 1, contagion: 1 });
    // history[1] wrapped row surfaces the persisted amplifiers.
    expect(body.history[1].amplifiers).toEqual({ psi: 1.05, contagion: 1.2 });
  });

  it("uses the oldest returned aggregate row for freshness headers", async () => {
    const requestNowSec = Math.floor(Date.now() / 1000);
    const freshComputedAt = requestNowSec - 60;
    const staleComputedAt = requestNowSec - 8_000;
    const db = mockD1([
      {
        match: "stress_signals",
        rows: [
          {
            stablecoin_id: "usdt-tether",
            score: 12,
            band: "CALM",
            signals_json: signalsJson,
            computed_at: freshComputedAt,
          },
          {
            stablecoin_id: "usdc-circle",
            score: 40,
            band: "WATCH",
            signals_json: signalsJson,
            computed_at: staleComputedAt,
          },
        ],
      },
    ]);

    const res = await handleStressSignals(db, new URL("https://x/api/stress-signals"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      updatedAt: number;
      oldestComputedAt?: number;
    };
    expect(body.updatedAt).toBe(freshComputedAt);
    expect(body.oldestComputedAt).toBe(staleComputedAt);
    expect(Number(res.headers.get("X-Data-Age"))).toBeGreaterThanOrEqual(8_000);
    expect(res.headers.get("Warning")).toContain("Response is stale");
  });
});
