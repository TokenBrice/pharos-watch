import { describe, expect, expectTypeOf, it } from "vitest";
import * as dewsContracts from "../contracts";
import type {
  DewsComputedRow,
  DewsSourceState,
  MalformedPersistedInput,
  PersistedJsonDecodeReason,
  StablecoinsDependencyDiagnostics,
} from "../contracts";

// Type assertions are checked by `npm run typecheck:worker`; Vitest transpiles
// them away. The namespace import is the executable owner of this type-only
// contract module, and its emptiness below is the runtime half of the same
// boundary: wire contracts may not grow runtime state or side effects.
expectTypeOf<PersistedJsonDecodeReason>().toEqualTypeOf<"missing" | "json-parse-failed" | "invalid-shape">();
expectTypeOf<MalformedPersistedInput["degradesRun"]>().toEqualTypeOf<boolean>();
expectTypeOf<MalformedPersistedInput["reason"]>().toEqualTypeOf<PersistedJsonDecodeReason>();
expectTypeOf<StablecoinsDependencyDiagnostics["reason"]>().toEqualTypeOf<string | null>();
expectTypeOf<DewsComputedRow["stablecoinId"]>().toEqualTypeOf<string>();
expectTypeOf<DewsSourceState["dependencyDiagnostics"]>().toHaveProperty("psi");

describe("DEWS wire contracts", () => {
  it("stays a type-only module with no runtime exports", () => {
    expect(Object.keys(dewsContracts)).toEqual([]);
  });

  it("keeps the persisted decode reason vocabulary closed", () => {
    const reasons: Record<PersistedJsonDecodeReason, true> = {
      missing: true,
      "json-parse-failed": true,
      "invalid-shape": true,
    };

    expect(Object.keys(reasons)).toEqual(["missing", "json-parse-failed", "invalid-shape"]);
  });
});
