import { describe, expect, it } from "vitest";

import {
  findBareFetchCalls,
  scanProviderResilience,
} from "../ci/check-provider-resilience.ts";
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
      body: "Drains response body.",
      circuitSources: ["CIRCUIT_SOURCE.DEMO"],
    },
    requiredMarkers: ["AbortSignal.timeout", "drainResponseBody", "CIRCUIT_SOURCE.DEMO"],
  },
];

describe("provider resilience checker", () => {
  it("detects bare global fetch calls without matching property fetches", () => {
    const calls = findBareFetchCalls(`
      export default { async fetch() { return new Response("ok"); } };
      await client.fetch("/internal");
      return fetch("https://example.test");
    `);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("return fetch");
  });

  it("passes a registered direct provider with timeout, body, circuit, and test coverage", () => {
    withTempRepo("pharos-provider-resilience", {
      "worker/src/provider.ts": `
        const marker = "CIRCUIT_SOURCE.DEMO";
        async function drainResponseBody(_res: Response) {}
        export async function run() {
          const res = await fetch("https://example.test", { signal: AbortSignal.timeout(1000) });
          await drainResponseBody(res);
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

  it("validates the checked-in provider resilience registry", () => {
    const report = scanProviderResilience();
    expect(report.violations).toEqual([]);
  });
});
