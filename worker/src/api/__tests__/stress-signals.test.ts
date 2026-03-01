import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleStressSignals } from "../stress-signals";
import {
  StressSignalsAllResponseSchema,
  StressSignalDetailResponseSchema,
} from "../../../../src/lib/types";

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
            stablecoin_id: "1",
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
    const body = await res.json();

    const parsed = StressSignalsAllResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(body).toHaveProperty("signals");
    expect(body).toHaveProperty("updatedAt");
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

    const url = new URL("https://x/api/stress-signals?stablecoin=1&days=7");
    const res = await handleStressSignals(db, url);

    expect(res.status).toBe(200);
    const body = await res.json();

    const parsed = StressSignalDetailResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(body).toHaveProperty("current");
    expect(body).toHaveProperty("history");
  });

  it("rejects invalid stablecoin ID with 400", async () => {
    const db = mockD1();
    const url = new URL("https://x/api/stress-signals?stablecoin=../etc/passwd");
    const res = await handleStressSignals(db, url);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid");
  });
});
