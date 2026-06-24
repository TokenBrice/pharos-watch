import { describe, expect, it } from "vitest";
import { DATA_DEPENDENCY_BY_ID, DATA_DEPENDENCY_REGISTRY } from "../data-dependency-registry";
import { getCronJobMeta } from "../cron-jobs";

describe("data dependency registry", () => {
  it("uses unique ids and valid dependency references", () => {
    const ids = DATA_DEPENDENCY_REGISTRY.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(DATA_DEPENDENCY_BY_ID.size).toBe(DATA_DEPENDENCY_REGISTRY.length);

    for (const definition of DATA_DEPENDENCY_REGISTRY) {
      expect(definition.label).toBeTruthy();
      expect(definition.sourceOfTruth).toBeTruthy();
      expect(definition.consumers.length).toBeGreaterThan(0);
      for (const parentId of definition.dependsOn) {
        expect(DATA_DEPENDENCY_BY_ID.has(parentId), `${definition.id} depends on unknown ${parentId}`).toBe(true);
      }
    }
  });

  it("points producer-backed dependencies at declared cron jobs", () => {
    for (const definition of DATA_DEPENDENCY_REGISTRY) {
      if (!definition.producerJob) continue;
      expect(getCronJobMeta(definition.producerJob), `${definition.id} producer ${definition.producerJob}`).not.toBeNull();
    }
  });
});
