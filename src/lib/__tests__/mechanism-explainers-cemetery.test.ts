import { describe, expect, it } from "vitest";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import { ARCHETYPE_CONTENT } from "../mechanism-explainers";

describe("mechanism explainer cemetery membership", () => {
  const cemeteryById = new Map(CEMETERY_ENTRIES.map((entry) => [entry.id, entry]));

  for (const content of Object.values(ARCHETYPE_CONTENT)) {
    for (const entry of content.decommissioned ?? []) {
      it(`${content.archetype}: ${entry.coinId} links to a cemetery record with the same mechanism`, () => {
        const cemeteryEntry = entry.coinId ? cemeteryById.get(entry.coinId) : undefined;
        expect(cemeteryEntry, `Unknown cemetery id: ${entry.coinId}`).toBeDefined();
        expect(cemeteryEntry?.mechanismArchetype).toBe(content.archetype);
      });
    }
  }
});
