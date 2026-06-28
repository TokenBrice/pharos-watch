import { describe, expect, it } from "vitest";
import {
  classifyArtifactFailure,
  missingOptionalArtifactGap,
} from "../maintenance/watch-worker-cron.mjs";

describe("watch-worker-cron artifact gap classification", () => {
  it("classifies missing optional rollout tables as info-level artifact gaps", () => {
    const descriptor = {
      artifact: "surfacePublicationGenerations",
      table: "surface_publication_generations",
      optionalMissing: true,
    };

    expect(missingOptionalArtifactGap(descriptor)).toMatchObject({
      artifact: "surfacePublicationGenerations",
      table: "surface_publication_generations",
      code: "missing_table",
      severity: "info",
      optional: true,
    });
    expect(classifyArtifactFailure(
      descriptor,
      "D1_ERROR: no such table: surface_publication_generations",
    )).toMatchObject({
      code: "missing_table",
      severity: "info",
      optional: true,
    });
  });

  it("keeps established publication ledger failures warning-level", () => {
    expect(classifyArtifactFailure(
      {
        artifact: "dexPublicationGenerations",
        table: "dex_liquidity_publication_generations",
        optionalMissing: false,
      },
      "D1_ERROR: no such column: current_row_count",
    )).toMatchObject({
      artifact: "dexPublicationGenerations",
      code: "query_failed",
      severity: "warning",
      optional: false,
    });
  });
});
