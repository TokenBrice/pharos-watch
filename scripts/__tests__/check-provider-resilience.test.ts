import { describe, expect, it } from "vitest";

import {
  findBareFetchCalls,
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
  it.each([
    ["fetch(url);", 1],
    ["const request = fetch; request(url);", 1],
    ["const request = fetch; let copy; copy = request; copy(url);", 1],
    ["let request = fetch; const copy = request; request = local; copy(url); request(url);", 1],
    ["const request = fetch; function run(request) { request(url); } request(url);", 1],
    ["function run(fetch) { const request = fetch; request(url); }", 0],
    ["import { fetch } from './adapter'; const request = fetch; request(url);", 0],
    ["const adapter = { fetch(url) {} }; adapter.fetch(url);", 0],
    ["// fetch(url)\nconst note = 'fetch(url)'; const pattern = /fetch\\(/;", 0],
  ] as const)("discovers global fetch aliases without confusing local or inert syntax: %s", (source, count) => {
    expect(findBareFetchCalls(source)).toHaveLength(count);
  });

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

  it.each(["fetch", "request"])("passes a registered direct %s provider with resilience coverage", (callee) => {
    withTempRepo("pharos-provider-resilience", {
      "worker/src/provider.ts": `
        const marker = "CIRCUIT_SOURCE.DEMO";
        const request = fetch;
        async function cancelResponseBodyQuietly(res: Response) { await res.body?.cancel(); }
        export async function run() {
          const res = await ${callee}("https://example.test", { signal: AbortSignal.timeout(1000) });
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

  it.each(["fetch", "request"])("fails when a registered fetchWithRetry surface adds bare %s", (callee) => {
    withTempRepo("pharos-provider-resilience", {
      "worker/src/provider.ts": `
        import { fetchWithRetry } from "./fetch-retry";
        const request = fetch;
        export async function run() {
          await ${callee}("https://example.test", { signal: AbortSignal.timeout(1000) });
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

  it.each(["fetch", "request"])("fails when a new direct %s file is not registered", (callee) => {
    withTempRepo("pharos-provider-resilience", {
      "worker/src/unregistered.ts": `
        const request = fetch;
        export async function run() {
          return ${callee}("https://example.test", { signal: AbortSignal.timeout(1000) });
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
