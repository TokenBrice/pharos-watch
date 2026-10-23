import { afterEach, describe, expect, it, vi } from "vitest";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { SAFETY_SCORE_V9_STABLECOINS_CAPTURE_MAX_AGE_SEC } from "../../cron/compute-safety-score-v9";
import { buildSafetyScoreV9Candidate } from "../safety-score-v9/candidate";
import { createNativeSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input";

afterEach(() => { vi.useRealTimers(); });

// Two full-registry compiles exceed the 20 s default on hosted runners; match
// the native-input pipeline suite's V9 evaluation budget.
const V9_EVALUATION_TEST_TIMEOUT_MS = 240_000;

// The publisher admits a capture that lags the live stablecoins cache by up to
// SAFETY_SCORE_V9_STABLECOINS_CAPTURE_MAX_AGE_SEC. Every evidence age (peg and
// chainSupply at 2 x 900 s included) is measured against the capture's frozen
// `clockSec`, never the compile wall clock, so a late compile must score
// byte-identically to an on-time one.
describe("Safety Score V9 compile clock", () => {
  it("compiles a capture identically on time and at the lag budget", () => {
    const fixedInput = createNativeSafetyScoreV9FullRegistryInput();
    const compileAt = (wallSec: number) => {
      vi.useFakeTimers();
      vi.setSystemTime(wallSec * 1_000);
      const result = buildSafetyScoreV9Candidate({ fixedInput, publishedAtSec: fixedInput.clockSec });
      vi.useRealTimers();
      return stableJsonStringifyV1(result.candidate);
    };

    const onTime = compileAt(fixedInput.clockSec);
    const late = compileAt(fixedInput.updatedAt + SAFETY_SCORE_V9_STABLECOINS_CAPTURE_MAX_AGE_SEC);

    expect(late === onTime).toBe(true);
  }, V9_EVALUATION_TEST_TIMEOUT_MS);
});
