import { describe, expect, it } from "vitest";
import { DATA_DEPENDENCY_REGISTRY } from "../data-dependency-registry";
import { getCronJobMeta } from "../cron-jobs";

describe("data dependency registry", () => {
  it("points producer-backed dependencies at declared cron jobs", () => {
    for (const definition of DATA_DEPENDENCY_REGISTRY) {
      if (!definition.producerJob) continue;
      expect(getCronJobMeta(definition.producerJob), `${definition.id} producer ${definition.producerJob}`).not.toBeNull();
    }
  });
});
