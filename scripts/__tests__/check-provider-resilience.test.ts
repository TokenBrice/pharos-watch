import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    ["declare function fetch(): Promise<Response>;\nfetch(url);", 1],
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

  it("still scans a bare fetch spelled with a unicode escape", () => {
    withTempRepo("pharos-provider-resilience", {
      "worker/src/escaped.ts": "export async function run() { return \\u0066etch(url); }",
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

  // One shared program resolves `fetch` in every scanned module to a global
  // augmentation declared elsewhere, so symbol presence must not read as a local
  // shadow. The per-file checker never sees the augmentation and always finds
  // the call; the scan has to agree.
  it("keeps finding bare fetch when another scanned module augments the global", () => {
    const files = {
      "worker/src/global-fetch.d.ts": "declare global { var fetch: (input: string) => Promise<Response>; }\nexport {};\n",
      "worker/src/one.ts": 'export async function one() { return fetch("https://example.test/one"); }',
      "worker/src/two.ts": 'export async function two() { return fetch("https://example.test/two"); }',
    };
    withTempRepo("pharos-provider-resilience", files, (cwd) => {
      for (const file of ["worker/src/one.ts", "worker/src/two.ts"]) {
        expect(findBareFetchCalls(readFileSync(join(cwd, file), "utf8"), file)).toHaveLength(1);
      }
      const report = scanProviderResilience({
        cwd,
        registry: [],
        requiredFamilies: [],
        directFetchRoots: ["worker/src"],
      });

      expect(report.violations
        .map((violation) => `${violation.kind}:${violation.file}:${violation.line}`)
        .sort()).toEqual([
        "unregistered-direct-fetch:worker/src/one.ts:1",
        "unregistered-direct-fetch:worker/src/two.ts:1",
      ]);
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
