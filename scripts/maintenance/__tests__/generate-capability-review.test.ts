import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { CAPABILITY_REGISTRY, type CapabilityDefinition } from "../capability-registry";
import {
  buildCapabilityReviewReport,
  collectGitActivity,
  collectRepositoryFootprint,
  loadControlCenterEvidence,
  matchesCapabilityPath,
  parseGitLog,
  renderCapabilityReview,
  routeMatches,
  validateCapabilityRegistry,
  type ControlCenterEvidence,
} from "../generate-capability-review";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pharos-capability-review-"));
}

function capability(overrides: Partial<CapabilityDefinition> = {}): CapabilityDefinition {
  return {
    id: "feature",
    name: "Feature",
    purpose: "Serve a specific user need.",
    strategicRationale: "The feature has a documented strategic purpose.",
    routes: ["/feature/"],
    codePaths: ["src/feature"],
    analyticsEvents: ["feature_used"],
    apiRoutes: ["feature"],
    cronJobs: ["feature-job"],
    decision: {
      state: "unreviewed",
      reviewedAt: null,
      reviewAfter: "2026-07-19",
      rationale: "Initial review pending.",
    },
    ...overrides,
  };
}

function unavailableControlCenter(): ControlCenterEvidence {
  return {
    available: false,
    path: null,
    latestCollectedAt: null,
    warnings: ["Control-center database was not supplied."],
    sourceStatuses: [],
    traffic: [],
    search: [],
    productEvents: [],
    apiRoutes: [],
    telegram: null,
  };
}

function emptyControlCenter(lastCollectedAt: number): ControlCenterEvidence {
  return {
    available: true,
    path: "/tmp/control-center.db",
    latestCollectedAt: lastCollectedAt,
    warnings: [],
    sourceStatuses: ["ga4", "gsc", "apikeys", "telegram"].map((source) => ({
      source,
      lastCollectedAt,
      ok: true,
      skipped: false,
      note: null,
      error: null,
    })),
    traffic: [],
    search: [],
    productEvents: [],
    apiRoutes: [],
    telegram: null,
  };
}

describe("capability registry", () => {
  it("keeps the real MVP registry valid and bounded", () => {
    expect(validateCapabilityRegistry(CAPABILITY_REGISTRY, REPO_ROOT)).toEqual([]);
    expect(CAPABILITY_REGISTRY).toHaveLength(11);
  });

  it("rejects duplicates, invalid review state, missing paths, and unknown jobs", () => {
    const root = tempDir();
    mkdirSync(join(root, "src", "feature"), { recursive: true });
    writeFileSync(join(root, "src", "feature", "index.ts"), "export {};\n", "utf8");
    const first = capability({
      purpose: "",
      codePaths: ["src/missing"],
      decision: {
        state: "invalid" as CapabilityDefinition["decision"]["state"],
        reviewedAt: null,
        reviewAfter: "bad",
        rationale: "",
      },
    });
    const errors = validateCapabilityRegistry([first, capability()], root, new Set(["known-job"]));

    expect(errors).toEqual(
      expect.arrayContaining([
        "feature: duplicate capability id.",
        "feature: purpose is required.",
        "feature: decision rationale is required.",
        "feature: unknown state invalid.",
        "feature: reviewAfter must be an ISO date.",
        "feature: reviewed state requires an ISO reviewedAt date.",
        "feature: code path does not exist: src/missing",
        "feature: unknown cron job: feature-job",
      ]),
    );
  });
});

describe("path and Git evidence", () => {
  it("matches route prefixes, exact root, and one-segment wildcards", () => {
    expect(routeMatches("/", "/")).toBe(true);
    expect(routeMatches("/yield/history", "/yield/")).toBe(true);
    expect(routeMatches("/stablecoin/usdc-circle/yield/", "/stablecoin/*/yield/")).toBe(true);
    expect(routeMatches("/stablecoin/usdc-circle/", "/stablecoin/*/yield/")).toBe(false);
    expect(routeMatches("/stablecoin/", "/stablecoin/*/")).toBe(false);
    expect(routeMatches("/about/", "/")).toBe(false);
  });

  it("matches only exact files or descendants of a directory prefix", () => {
    expect(matchesCapabilityPath("src/app/yield/page.tsx", ["src/app/yield"])).toBe(true);
    expect(matchesCapabilityPath("src/app/yields/page.tsx", ["src/app/yield"])).toBe(false);
    expect(matchesCapabilityPath("src/app/page.tsx", ["src/app/page.tsx"])).toBe(true);
  });

  it("counts authored source and tests while excluding generated files and fixtures", () => {
    const root = tempDir();
    mkdirSync(join(root, "src", "feature", "__fixtures__"), { recursive: true });
    writeFileSync(join(root, "src", "feature", "index.ts"), "one\ntwo\n", "utf8");
    writeFileSync(join(root, "src", "feature", "index.test.ts"), "test\n", "utf8");
    writeFileSync(join(root, "src", "feature", "client.generated.ts"), "generated\n", "utf8");
    writeFileSync(join(root, "src", "feature", "__fixtures__", "sample.ts"), "fixture\n", "utf8");

    expect(
      collectRepositoryFootprint(
        root,
        [
          "src/feature/index.ts",
          "src/feature/index.test.ts",
          "src/feature/client.generated.ts",
          "src/feature/__fixtures__/sample.ts",
        ],
        ["src/feature"],
      ),
    ).toEqual({ sourceFiles: 1, testFiles: 1, approximateLoc: 2 });
  });

  it("parses and attributes commit activity without shell heuristics", () => {
    const commits = parseGitLog(
      "\x1eaaa\x1ffix(feature): repair behavior\n\nsrc/feature/index.ts\n" +
        "\x1ebbb\x1ffeat(other): add behavior\n\nsrc/other/index.ts\n" +
        "\x1eccc\x1ffeat(feature): improve behavior\n\nsrc/feature/view.ts\n",
    );

    expect(commits).toHaveLength(3);
    expect(collectGitActivity(commits, ["src/feature"])).toEqual({
      commits: 2,
      fixes: 1,
      recentSubjects: ["fix(feature): repair behavior", "feat(feature): improve behavior"],
    });
  });
});

describe("control-center evidence", () => {
  it("reads only aggregate evidence and never exposes private API-key fields", () => {
    const root = tempDir();
    const dbPath = join(root, "control-center.db");
    const db = new DatabaseSync(dbPath);
    const collectedAt = Math.floor(Date.parse("2026-07-19T12:00:00Z") / 1000);
    db.exec(`
      CREATE TABLE source_status (
        source TEXT PRIMARY KEY, last_collected_at INTEGER, ok INTEGER, skipped INTEGER, note TEXT, error TEXT
      );
      CREATE TABLE traffic_pages (period TEXT, path TEXT, pageviews INTEGER, users INTEGER);
      CREATE TABLE search_pages (period TEXT, path TEXT, clicks INTEGER, impressions INTEGER);
      CREATE TABLE product_event_totals (period TEXT, event_name TEXT, event_count INTEGER, users INTEGER);
      CREATE TABLE telegram_daily (
        date TEXT, subscribers INTEGER, active_watchers INTEGER, new_watchers INTEGER, churned INTEGER
      );
      CREATE TABLE telegram_usage_daily (date TEXT, event_type TEXT, count INTEGER);
      CREATE TABLE raw_pulls (source TEXT, collected_at INTEGER, payload TEXT);
    `);
    const status = db.prepare("INSERT INTO source_status VALUES (?, ?, 1, 0, NULL, NULL)");
    for (const source of ["ga4", "gsc", "apikeys", "telegram"]) status.run(source, collectedAt);
    db.prepare("INSERT INTO traffic_pages VALUES ('2026-07', '/feature/', 120, 30)").run();
    db.prepare("INSERT INTO search_pages VALUES ('2026-07', '/feature/', 8, 400)").run();
    db.prepare("INSERT INTO product_event_totals VALUES ('rolling90', 'feature_used', 10, 4)").run();
    db.prepare("INSERT INTO telegram_daily VALUES ('2026-07-19', 50, 40, 3, 1)").run();
    db.prepare("INSERT INTO telegram_usage_daily VALUES ('2026-07-19', 'command', 7)").run();
    db.prepare("INSERT INTO raw_pulls VALUES ('apikeys', ?, ?)").run(
      collectedAt,
      JSON.stringify({
        topRoutes: [{ route: "feature", requests: 900 }],
        recentKeys: [{ owner: "private@example.com", name: "Private key owner" }],
      }),
    );
    db.close();

    const evidence = loadControlCenterEvidence(dbPath, "2026-04-20", "2026-07-19");
    expect(evidence.available).toBe(true);
    expect(evidence.traffic).toEqual([{ period: "2026-07", path: "/feature/", pageviews: 120, users: 30 }]);
    expect(evidence.apiRoutes).toEqual([{ route: "feature", requests: 900 }]);
    expect(JSON.stringify(evidence)).not.toContain("private@example.com");
    expect(JSON.stringify(evidence)).not.toContain("Private key owner");
  });

  it("fails open to unavailable evidence when the database is absent or incompatible", () => {
    const root = tempDir();
    expect(loadControlCenterEvidence(join(root, "missing.db"), "2026-04-20", "2026-07-19")).toMatchObject({
      available: false,
      traffic: [],
    });

    const dbPath = join(root, "bad.db");
    new DatabaseSync(dbPath).close();
    expect(loadControlCenterEvidence(dbPath, "2026-04-20", "2026-07-19")).toMatchObject({
      available: false,
      traffic: [],
    });
  });
});

describe("report rendering", () => {
  it("renders unavailable evidence honestly instead of converting it to zero", () => {
    const root = tempDir();
    mkdirSync(join(root, "src", "feature"), { recursive: true });
    writeFileSync(join(root, "src", "feature", "index.ts"), "export {};\n", "utf8");
    const report = buildCapabilityReviewReport({
      repoRoot: root,
      registry: [capability({ cronJobs: [] })],
      trackedFiles: ["src/feature/index.ts"],
      commits: [],
      controlCenter: unavailableControlCenter(),
      asOf: "2026-07-19",
      since: "2026-04-20",
    });
    const rendered = renderCapabilityReview(report);

    expect(rendered).toContain("| Feature | unreviewed | unavailable | unavailable | unavailable | unavailable |");
    expect(rendered).not.toContain("0 views");
    expect(rendered).toContain("The generator does not recommend a lifecycle state.");
    expect(rendered).toContain("Git activity window: 2026-04-20 through 2026-07-19.");
  });

  it("renders stale sources as partial and bounded-sample absence as not observed", () => {
    const root = tempDir();
    mkdirSync(join(root, "src", "feature"), { recursive: true });
    writeFileSync(join(root, "src", "feature", "index.ts"), "export {};\n", "utf8");
    const staleAt = Math.floor(Date.parse("2026-07-01T12:00:00Z") / 1000);
    const report = buildCapabilityReviewReport({
      repoRoot: root,
      registry: [capability({ cronJobs: [] })],
      trackedFiles: ["src/feature/index.ts"],
      commits: [],
      controlCenter: emptyControlCenter(staleAt),
      asOf: "2026-07-19",
      since: "2026-04-20",
    });
    const rendered = renderCapabilityReview(report);

    expect(report.capabilities[0]?.usageAvailability).toBe("partial");
    expect(rendered).toContain("not observed in bounded sample");
    expect(rendered).toContain("usage evidence partial");
    expect(rendered).toContain("Mapped high-intent events not observed in the rolling90 event table: feature_used.");
    expect(rendered).toContain("Mapped API routes not observed in the bounded top-routes sample: feature.");
    expect(rendered).not.toContain("0 views");
  });
});
