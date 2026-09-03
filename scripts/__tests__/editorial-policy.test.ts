import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  EDITORIAL_REGISTER_IDS,
  EDITORIAL_STYLE_HASH,
  EDITORIAL_STYLE_VERSION,
  scanEditorialText,
} from "@shared/lib/editorial-style";

import {
  EDITORIAL_BASELINE_PATH,
  EDITORIAL_SURFACE_REGISTRY,
  EDITORIAL_POLICY_TEST_PATH,
  validateEditorialSurfaceRegistry,
} from "../lib/editorial-surface-registry";
import {
  applyEditorialExceptions,
  buildEditorialBaseline,
  compareEditorialBaseline,
  editorialBaselineKey,
  fingerprintEditorialObservation,
  readEditorialExceptions,
  validateEditorialExceptions,
  type EditorialBaselineFile,
  type EditorialException,
  type EditorialObservation,
} from "../lib/editorial-baseline";
import { extractUnitsForSurface } from "../lib/editorial-extractors";
import {
  assertEditorialSourcesRegistered,
  collectGateObservations,
  EDITORIAL_POLICY_MODE,
  formatGateDiagnostics,
  runEditorialPolicyGate,
} from "../lib/editorial-gate";

const FIXED_GENERATED_AT = "2026-09-01T00:00:00.000Z";

function fixtureObservation({
  context = "Supply fell — the peg held.",
  severity = "hard",
  rule = "no-clause-dash",
}: {
  context?: string;
  severity?: "hard" | "advisory";
  rule?: string;
} = {}): EditorialObservation {
  return {
    surface: "fixture-json",
    record: "fixture",
    field: "text",
    rule,
    excerpt: "—",
    context,
    finding: {
      ruleId: rule,
      severity,
      promptLabel: "Fixture policy rule.",
      excerpt: "—",
      index: context.indexOf("—"),
    },
  };
}

function fixtureBaseline(observations: readonly EditorialObservation[]): EditorialBaselineFile {
  return buildEditorialBaseline(observations, {
    policyVersion: EDITORIAL_STYLE_VERSION,
    policyHash: EDITORIAL_STYLE_HASH,
    generatedAt: FIXED_GENERATED_AT,
  });
}

function fixtureException(
  observation: EditorialObservation,
  fingerprints = [fingerprintEditorialObservation(observation)],
): EditorialException {
  return {
    surface: observation.surface,
    record: observation.record,
    field: observation.field,
    ruleId: observation.rule,
    excerpt: observation.excerpt,
    fingerprints,
    reason: "Retained external quotation.",
    owner: "content",
    permanent: true,
  };
}

describe("editorial corpus policy gate", () => {
  // Scans the entire editorial corpus; the 5 s default is for unit-sized work
  // and this case timed out inside a loaded four-way CI shard (1.1 s locally).
  it("records corpus findings in shadow mode and reserves blocking for the config flip", () => {
    const result = runEditorialPolicyGate();
    expect(result.observations).toEqual(expect.any(Array));
    if (EDITORIAL_POLICY_MODE === "enforce") {
      expect(result.blockingRegressions, formatGateDiagnostics(result)).toEqual([]);
    }
  }, 30_000);

  it("keeps every source family registered and every surface assigned a known register", () => {
    expect(EDITORIAL_POLICY_TEST_PATH).toBe("scripts/__tests__/editorial-policy.test.ts");
    validateEditorialSurfaceRegistry(EDITORIAL_SURFACE_REGISTRY, new Set(EDITORIAL_REGISTER_IDS));
    expect(new Set(EDITORIAL_SURFACE_REGISTRY.map((surface) => surface.extractor))).toEqual(
      new Set(["json-fields", "structured-data", "markdown-body"]),
    );
  });

  it("rejects prose fields as configured record identity", () => {
    for (const identityField of ["label", "heading", "title", "name", "term"]) {
      expect(() => validateEditorialSurfaceRegistry([{
        id: `fixture-${identityField}`,
        register: "daily",
        paths: ["fixture.json"],
        extractor: "json-fields",
        ownership: "pharos",
        tier: "committed-corpus",
        options: { identityFields: [identityField] },
      }])).toThrow(/uses prose identity field/);
    }
  });

  it("refuses an unregistered prose corpus instead of silently ignoring it", () => {
    expect(() => assertEditorialSourcesRegistered(["data/new-prose-corpus.json"])).toThrow(/Unregistered editorial corpus/);
  });

  it("does not permit an unscoped Selector-style allow", () => {
    const root = mkdtempSync(resolve(tmpdir(), "pharos-editorial-allow-"));
    try {
      writeFileSync(resolve(root, "fixture.json"), JSON.stringify({
        text: "Supply fell — the peg held.",
        allow: "banned-phrase-allow: old",
      }));
      expect(() => collectGateObservations({
        root,
        exceptions: [],
        registry: [{
          id: "fixture-json",
          register: "daily",
          paths: ["fixture.json"],
          extractor: "json-fields",
          ownership: "pharos",
          tier: "committed-corpus",
          options: { fields: ["text"], rootRecord: "file" },
        }],
      })).toThrow(/unscoped editorial allow/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("records a newly injected hard violation as a regression without blocking shadow mode", () => {
    const root = mkdtempSync(resolve(tmpdir(), "pharos-editorial-gate-"));
    try {
      writeFileSync(resolve(root, "fixture.json"), JSON.stringify({ text: "Supply fell — the peg held." }));
      const baselinePath = resolve(root, "baseline.json");
      const exceptionsPath = resolve(root, "exceptions.json");
      writeFileSync(
        baselinePath,
        `${JSON.stringify(buildEditorialBaseline([], {
          policyVersion: EDITORIAL_STYLE_VERSION,
          policyHash: EDITORIAL_STYLE_HASH,
          generatedAt: "2026-09-01T00:00:00.000Z",
        }))}\n`,
      );
      writeFileSync(exceptionsPath, `${JSON.stringify({ version: 1, exceptions: [] })}\n`);
      const result = runEditorialPolicyGate({
        root,
        baselinePath,
        exceptionsPath,
        registry: [{
          id: "fixture-json",
          register: "daily",
          paths: ["fixture.json"],
          extractor: "json-fields",
          ownership: "pharos",
          tier: "committed-corpus",
          options: { fields: ["text"], rootRecord: "file" },
        }],
      });
      expect(result.observations.length).toBeGreaterThan(0);
      expect(result.regressions.length).toBeGreaterThan(0);
      expect(result.blockingRegressions.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires non-expired owned exceptions and supports permanent debt explicitly", () => {
    const selector = {
      surface: "fixture-json",
      record: "fixture",
      field: "text",
      ruleId: "no-clause-dash",
      fingerprints: ["0123456789abcdef"],
      reason: "Statutory quotation retained until legal review.",
      owner: "content",
    };
    const key = editorialBaselineKey({ ...selector, rule: selector.ruleId });
    const now = new Date("2026-09-01T00:00:00.000Z");
    expect(() => validateEditorialExceptions(
      [{ ...selector, expiresAt: "2026-10-01T00:00:00.000Z" }],
      new Set([key]),
      { now },
    )).not.toThrow();
    expect(() => validateEditorialExceptions(
      [{ ...selector, expiresAt: "2026-08-31T00:00:00.000Z" }],
      new Set([key]),
      { now },
    )).toThrow(/expired/);
    expect(() => validateEditorialExceptions(
      [{ ...selector, permanent: true }],
      new Set([key]),
      { now },
    )).not.toThrow();
    expect(() => validateEditorialExceptions(
      [{ ...selector, permanent: true, expiresAt: "2026-10-01T00:00:00.000Z" }],
      new Set([key]),
      { now },
    )).toThrow(/must not carry expiresAt/);
    expect(() => validateEditorialExceptions(
      [{ ...selector, permanent: true }],
      new Set(),
      { now },
    )).toThrow(/Orphaned/);
  });

  it("does not let exact-fingerprint exceptions absorb a new authored violation inserted first", () => {
    const authored = fixtureObservation({ context: "Authored claim — new conclusion." });
    const quotedOne = fixtureObservation({ context: "Evidence cites 'Report — first title'." });
    const quotedTwo = fixtureObservation({ context: "Evidence cites 'Study — second title'." });
    const exception = fixtureException(quotedOne, [
      fingerprintEditorialObservation(quotedOne),
      fingerprintEditorialObservation(quotedTwo),
    ]);
    expect(applyEditorialExceptions([authored, quotedOne, quotedTwo], [exception])).toEqual([authored]);
  });

  it("reports new hard findings as blocking and new advisory findings as report-only", () => {
    const hard = compareEditorialBaseline([fixtureObservation()], fixtureBaseline([]));
    const advisoryObservation = fixtureObservation({
      context: "Supply quietly changed.",
      rule: "scoped-decorative-word",
      severity: "advisory",
    });
    const advisory = compareEditorialBaseline([advisoryObservation], fixtureBaseline([]));
    expect(hard).toEqual([expect.objectContaining({ kind: "new", severity: "hard", blocking: true })]);
    expect(advisory).toEqual([expect.objectContaining({ kind: "new", severity: "advisory", blocking: false })]);
  });

  it("reports fixed debt as a blocking stale regression with the regeneration command", () => {
    const regressions = compareEditorialBaseline([], fixtureBaseline([fixtureObservation()]));
    expect(regressions).toEqual([expect.objectContaining({
      kind: "stale",
      blocking: true,
      message: expect.stringContaining("npm run generate:editorial-baseline"),
    })]);
  });

  it("detects an identical violation reintroduced after the stale baseline was regenerated", () => {
    const observation = fixtureObservation();
    const baselineAfterRemoval = fixtureBaseline([]);
    expect(compareEditorialBaseline([observation], baselineAfterRemoval)).toEqual([
      expect.objectContaining({ kind: "new", blocking: true }),
    ]);
  });

  it("rejects partially consumed exact-fingerprint allowances", () => {
    const observation = fixtureObservation();
    const exception = fixtureException(observation, [
      fingerprintEditorialObservation(observation),
      "0000000000000000",
    ]);
    expect(() => applyEditorialExceptions([observation], [exception])).toThrow(/only partially consumed/);
  });

  it("rejects an exact-fingerprint exception that matches nothing", () => {
    const observation = fixtureObservation();
    const exception = fixtureException(observation, ["0000000000000000"]);
    expect(() => applyEditorialExceptions([observation], [exception])).toThrow(/matches nothing/);
  });

  it("rejects unknown exception surface and rule ids distinctly", () => {
    const observation = fixtureObservation();
    const exception = fixtureException(observation);
    const key = editorialBaselineKey(observation);
    expect(() => validateEditorialExceptions(
      [{ ...exception, surface: "unknown-surface" }],
      new Set([editorialBaselineKey({ ...observation, surface: "unknown-surface" })]),
      { knownSurfaceIds: new Set([observation.surface]), knownRuleIds: new Set([observation.rule]) },
    )).toThrow(/unknown surface id/);
    expect(() => validateEditorialExceptions(
      [{ ...exception, ruleId: "unknown-rule" }],
      new Set([editorialBaselineKey({ ...observation, rule: "unknown-rule" })]),
      { knownSurfaceIds: new Set([observation.surface]), knownRuleIds: new Set([observation.rule]) },
    )).toThrow(/unknown rule id/);
    expect(key).not.toBe("");
  });

  it("rejects malformed fingerprints and missing reasons distinctly", () => {
    const observation = fixtureObservation();
    const exception = fixtureException(observation);
    const key = new Set([editorialBaselineKey(observation)]);
    expect(() => validateEditorialExceptions([{ ...exception, fingerprints: ["not-a-fingerprint"] }], key))
      .toThrow(/malformed fingerprint/);
    expect(() => validateEditorialExceptions([{ ...exception, reason: "" }], key))
      .toThrow(/non-empty reason/);
  });

  it("rejects malformed exception selectors", () => {
    const observation = fixtureObservation();
    const exception = fixtureException(observation);
    expect(() => validateEditorialExceptions(
      [{ ...exception, field: "text\u001fno-clause-dash" }],
      new Set([editorialBaselineKey(observation)]),
    )).toThrow(/incomplete selector/);
  });

  it("rejects typoed exception fields during strict file validation", () => {
    const root = mkdtempSync(resolve(tmpdir(), "pharos-editorial-exception-"));
    const path = resolve(root, "exceptions.json");
    try {
      const exception = fixtureException(fixtureObservation());
      const { excerpt: _excerpt, ...withoutExcerpt } = exception;
      writeFileSync(path, JSON.stringify({
        version: 1,
        exceptions: [{ ...withoutExcerpt, exerpt: "—" }],
      }));
      expect(() => readEditorialExceptions(path)).toThrow(/Unknown field "exerpt"/);
      const { reason: _reason, ...withoutReason } = exception;
      writeFileSync(path, JSON.stringify({ version: 1, exceptions: [withoutReason] }));
      expect(() => readEditorialExceptions(path)).toThrow(/field "reason" must be a string/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves generatedAt so identical baseline builds serialize byte-for-byte", () => {
    const first = fixtureBaseline([fixtureObservation()]);
    const second = buildEditorialBaseline([fixtureObservation()], {
      policyVersion: EDITORIAL_STYLE_VERSION,
      policyHash: EDITORIAL_STYLE_HASH,
      previousBaseline: first,
    });
    expect(`${JSON.stringify(second, null, 2)}\n`).toBe(`${JSON.stringify(first, null, 2)}\n`);
  });

  it("keeps JSON records stable when prose identity candidates change", () => {
    const surface = {
      id: "fixture-json",
      register: "daily",
      paths: ["fixture.json"],
      extractor: "json-fields",
      ownership: "pharos",
      tier: "committed-corpus",
      options: { fields: ["*.note"], rootRecord: "file" },
    } as const;
    for (const field of ["label", "heading", "title", "name", "term"]) {
      const source = (value: string) => JSON.stringify([{ id: "stable-record", [field]: value, note: "Supply remains stable." }]);
      const before = extractUnitsForSurface(surface, "fixture.json", source("Before"));
      const after = extractUnitsForSurface(surface, "fixture.json", source("After"));
      expect(after.map((unit) => unit.record), field).toEqual(before.map((unit) => unit.record));
      expect(before.map((unit) => unit.record)).toEqual(["fixture/id=stable-record"]);
    }
  });

  it("keeps structured records stable when prose identity candidates change", () => {
    const surface = {
      id: "fixture-structured",
      register: "daily",
      paths: ["fixture.ts"],
      extractor: "structured-data",
      ownership: "pharos",
      tier: "committed-corpus",
      options: { fields: ["note"] },
    } as const;
    for (const field of ["label", "heading", "title", "name", "term"]) {
      const source = (value: string) => `const records = [{ id: "stable-record", ${field}: "${value}", note: "Supply remains stable." }];`;
      const before = extractUnitsForSurface(surface, "fixture.ts", source("Before"));
      const after = extractUnitsForSurface(surface, "fixture.ts", source("After"));
      expect(after.map((unit) => unit.record), field).toEqual(before.map((unit) => unit.record));
      expect(before.map((unit) => unit.record)).toEqual(["fixture/id=stable-record"]);
    }
  });

  it("keys structured roots once and metadata roots by syntactic kind", () => {
    const structuredSurface = {
      id: "fixture-structured",
      register: "daily",
      paths: ["fixture.ts"],
      extractor: "structured-data",
      ownership: "pharos",
      tier: "committed-corpus",
      options: { fields: ["description"], identityFields: ["slug"] },
    } as const;
    const structuredUnits = extractUnitsForSurface(
      structuredSurface,
      "fixture.ts",
      'const record = { slug: "stable-slug", description: "Supply remains stable." };',
    );
    expect(structuredUnits.map((unit) => unit.record)).toEqual(["fixture/slug=stable-slug"]);

    const metadataSurface = EDITORIAL_SURFACE_REGISTRY.find((candidate) => candidate.id === "page-metadata")!;
    const metadataUnits = extractUnitsForSurface(metadataSurface, "src/app/fixture/page.tsx", `
      export const metadata = { title: "Metadata title", description: "Metadata description" };
      buildPageMetadata({ title: "Builder title", description: "Builder description" });
      createClientFeaturePage({ title: "Client title", description: "Client description" });
    `);
    expect(new Set(metadataUnits.map((unit) => unit.record))).toEqual(new Set([
      "src/app/fixture/page/metadata",
      "src/app/fixture/page/buildPageMetadata",
      "src/app/fixture/page/createClientFeaturePage",
    ]));
  });

  it("keeps annotation date and kind unique within each source file", () => {
    const directory = resolve(process.cwd(), "shared/data/annotations/coins");
    for (const filename of readdirSync(directory).filter((candidate) => candidate.endsWith(".json"))) {
      const records = JSON.parse(readFileSync(resolve(directory, filename), "utf8")) as Array<{
        date?: unknown;
        kind?: unknown;
      }>;
      const identities = records.map((record) => {
        expect(typeof record.date, `${filename} annotation date`).toBe("string");
        expect(typeof record.kind, `${filename} annotation kind`).toBe("string");
        return `${record.date}|${record.kind}`;
      });
      expect(new Set(identities).size, `${filename} duplicate date|kind`).toBe(identities.length);
    }
  });

  it("keeps identity labels out of the prose unit set", () => {
    const surface = EDITORIAL_SURFACE_REGISTRY.find((candidate) => candidate.id === "domain-sidecars")!;
    const source = JSON.stringify({
      mintAuthority: {
        controls: [{ label: "Safe — owner", role: "admin", note: "Authority remains mutable." }],
        controlRef: "Safe — owner",
      },
    });
    const units = extractUnitsForSurface(surface, "shared/data/stablecoins/domains/fixture.json", source);
    expect(units.some((unit) => unit.field.includes("controls.*.label"))).toBe(false);
    expect(units.some((unit) => unit.field.endsWith(".note"))).toBe(true);
  });

  it("honors quoted external titles without creating baseline observations", () => {
    const source = '[{"date":"2026-09-01","kind":"incident","label":"External — title","quoted":true,"note":"quoted"}]';
    const surface = EDITORIAL_SURFACE_REGISTRY.find((candidate) => candidate.id === "annotations")!;
    const units = extractUnitsForSurface(surface, "shared/data/annotations/coins/fixture.json", source);
    expect(units.some((unit) => unit.ownership === "quoted")).toBe(true);
    expect(scanEditorialText(units[0]?.text ?? "", { register: surface.register, ownership: "quoted" })).toEqual([]);
  });

  it("keeps the full-corpus sweep out of the PR planner command itself", () => {
    expect(existsSync(resolve(process.cwd(), EDITORIAL_BASELINE_PATH))).toBe(true);
  });
});
