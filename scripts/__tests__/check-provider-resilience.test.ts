import { describe, expect, it } from "vitest";

import {
  scanProviderResilience,
} from "../ci/check-provider-resilience.ts";
import { PROVIDER_RESILIENCE_REGISTRY } from "../lib/provider-resilience-registry.mjs";
import { withTempRepo } from "./helpers/test-state";

const validDirectFetchRegistry = [
  {
    id: "demo-direct",
    family: "demo",
    description: "Demo direct provider",
    files: ["worker/src/provider.ts"],
    tests: ["worker/src/provider.test.ts"],
    allowBareFetch: true,
    directFetchJustification: "Demo provider owns direct fetch classification for this fixture.",
    resilience: {
      transport: "direct-fetch",
      timeout: "Uses AbortSignal.timeout().",
      body: "Cancels unused response bodies.",
      circuitSources: ["CIRCUIT_SOURCE.DEMO"],
    },
    requiredMarkers: ["AbortSignal.timeout", "cancelResponseBodyQuietly"],
  },
];

describe("provider resilience checker", () => {
  it("keeps circuit-source enforcement without duplicated required markers", () => {
    for (const entry of PROVIDER_RESILIENCE_REGISTRY) {
      for (const circuitSource of entry.resilience.circuitSources) {
        if (circuitSource.startsWith("CIRCUIT_SOURCE.")) {
          expect(entry.requiredMarkers, entry.id).not.toContain(circuitSource);
        }
      }
    }
    const parityTrial = PROVIDER_RESILIENCE_REGISTRY.find((entry) => entry.id === "rpc-provider-parity-trial")!;
    expect(parityTrial.requiredMarkers).toContain("CIRCUIT_SOURCE.DWELLIR_EVM");

    withTempRepo("pharos-provider-resilience", {
      "worker/src/provider.ts": "AbortSignal.timeout; cancelResponseBodyQuietly;",
      "worker/src/provider.test.ts": "export {};",
    }, (cwd) => {
      const report = scanProviderResilience({
        cwd,
        registry: validDirectFetchRegistry,
        requiredFamilies: ["demo"],
        directFetchRoots: ["worker/src"],
      });
      expect(report.violations.map((violation) => violation.kind)).toEqual(["missing-circuit-source-marker"]);
    });
  });

  it("passes a registered direct provider with timeout, body, circuit, and test coverage", () => {
    withTempRepo("pharos-provider-resilience", {
      "worker/src/provider.ts": `
        const marker = "CIRCUIT_SOURCE.DEMO";
        async function cancelResponseBodyQuietly(res: Response) { await res.body?.cancel(); }
        export async function run() {
          const res = await fetch("https://example.test", { signal: AbortSignal.timeout(1000) });
          await cancelResponseBodyQuietly(res);
        }
      `,
      "worker/src/provider.test.ts": "export {};",
    }, (cwd) => {
      const report = scanProviderResilience({
        cwd,
        registry: validDirectFetchRegistry,
        requiredFamilies: ["demo"],
        directFetchRoots: ["worker/src"],
      });

      expect(report.violations).toEqual([]);
    });
  });

  it("fails when a registered fetchWithRetry surface adds bare fetch", () => {
    withTempRepo("pharos-provider-resilience", {
      "worker/src/provider.ts": `
        import { fetchWithRetry } from "./fetch-retry";
        export async function run() {
          await fetch("https://example.test", { signal: AbortSignal.timeout(1000) });
          await fetchWithRetry("https://example.test");
        }
      `,
      "worker/src/provider.test.ts": "export {};",
    }, (cwd) => {
      const report = scanProviderResilience({
        cwd,
        registry: [{
          id: "demo-wrapper",
          family: "demo",
          description: "Demo wrapper provider",
          files: ["worker/src/provider.ts"],
          tests: ["worker/src/provider.test.ts"],
          allowBareFetch: false,
          resilience: {
            transport: "fetchWithRetry",
            timeout: "Uses fetchWithRetry.",
            body: "Uses fetchWithRetry.",
            circuitSources: [],
          },
          requiredMarkers: ["fetchWithRetry"],
        }],
        requiredFamilies: ["demo"],
        directFetchRoots: ["worker/src"],
      });

      expect(report.violations.map((violation) => violation.kind)).toContain("direct-fetch-not-allowed");
    });
  });

  it("fails when a new direct fetch file is not registered", () => {
    withTempRepo("pharos-provider-resilience", {
      "worker/src/unregistered.ts": `
        export async function run() {
          return fetch("https://example.test", { signal: AbortSignal.timeout(1000) });
        }
      `,
    }, (cwd) => {
      const report = scanProviderResilience({
        cwd,
        registry: [],
        requiredFamilies: [],
        directFetchRoots: ["worker/src"],
      });

      expect(report.violations.map((violation) => violation.kind)).toContain("unregistered-direct-fetch");
    });
  });
});
