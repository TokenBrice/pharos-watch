import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleStressSignals } from "../stress-signals";
import {
  StressSignalsAllResponseSchema,
  StressSignalDetailResponseSchema,
} from "@shared/types";

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
});
