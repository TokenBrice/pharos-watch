import { describe, expect, it } from "vitest";
import { buildYieldHistoryEvaluationInputs } from "../coordinator-history";
import { evaluateYieldSources } from "../evaluation";
import {
  baseEvaluationInput,
  resolvedYield,
} from "../../__tests__/yield-evaluation.test-support";

describe("yield synchronous wrappers", () => {
  it("builds history inputs and evaluates a selected source", () => {
    const historyInputs = buildYieldHistoryEvaluationInputs({
      historyRows: [],
      prevTvlRows: [],
      prevBestRows: [],
    });
    const result = evaluateYieldSources(
      baseEvaluationInput({
        ...historyInputs,
        resolved: [
          {
            id: "coin-a",
            symbol: "A",
            yield: resolvedYield({ sourceKey: "source-a", currentApy: 4.2 }),
          },
        ],
      }),
    );

    expect(result.bestSourceKeyByCoin.get("coin-a")).toBe("source-a");
    expect(result.evaluatedSources).toHaveLength(1);
  });
});
