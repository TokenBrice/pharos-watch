import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  REQUIRED_DATA_MIGRATION_MODE,
  REQUIRED_ROLLOUT_SAFETY_MODE,
  ROLLOUT_SAFETY_ENFORCEMENT_PREFIX,
  UNSAFE_ROLLOUT_ADD_COLUMN_LABEL,
  DROP_INDEX_GRANDFATHER_THROUGH_SEQUENCE,
  createSchemaObjectManifest,
  parseDataMigrationManifestRows,
  parseManifestMigrationRows,
  parseRolloutSafetyPolicy,
  validateManifestMigrationParity,
  validateNoSqliteDotCommands,
  validateDuplicatePrefixes,
  validateRolloutSafetyAnnotation,
  validateRolloutSafetyPolicy,
  validateSchemaObjectManifest,
  validateWorkerMigrations,
} from "../ci/check-worker-migrations.ts";

const manifestText = `
## Individual Migrations (current active files)

| Sequence | Filename | Description |
| --- | --- | --- |
| 0072 | \`0072_telegram_launch_alerts.sql\` | Add launch alerts |
| 0073 | \`0073_price_cache_provenance.sql\` | Add provenance |

## Retired Individual Migrations

| Sequence | Former Filename | Retirement Note |
| --- | --- | --- |
| 0086 | \`0086_treasury_stable_exposure_history.sql\` | Retired |

## Reviewed Data Migrations

| Sequence | Filename | Predicate | Old-Worker compatibility | Rollback / bookmark | Expected row bounds |
| --- | --- | --- | --- | --- | --- |
| 0236 | \`0236_dex_deployment_attempt_attribution.sql\` | all outcome rows | legacy readers ignore the nullable column | Time Travel bookmark before deploy | no more than the existing outcome row count |

## Known Anomalies
`;

const rows = [
  {
    type: "table",
    name: "example",
    tblName: "example",
    sql: "CREATE TABLE example (id INTEGER PRIMARY KEY, value TEXT)",
  },
  {
    type: "index",
    name: "idx_example_value",
    tblName: "example",
    sql: "CREATE INDEX idx_example_value ON example(value)",
  },
];

describe("parseRolloutSafetyPolicy", () => {
  it("reads the rollout-safety cutoff and required header from the manifest text", () => {
    const policy = parseRolloutSafetyPolicy(`
## Rollout Safety

- Rollout-safety enforcement starts at: \`0071\`
- Required rollout-safety header: \`-- rollout-safety: backward-compatible\`
`);

    expect(policy).toEqual({
      enforcementPrefix: "0071",
      requiredMode: "backward-compatible",
    });
  });
});

describe("parseManifestMigrationRows", () => {
  it("reads migration table rows from a bounded manifest section", () => {
    expect(
      parseManifestMigrationRows(manifestText, {
        sectionHeading: "## Individual Migrations",
        nextHeading: "## Retired Individual Migrations",
      }),
    ).toEqual([
      { sequence: "0072", filename: "0072_telegram_launch_alerts.sql" },
      { sequence: "0073", filename: "0073_price_cache_provenance.sql" },
    ]);
  });
});

describe("validateManifestMigrationParity", () => {
  it("rejects squashed manifest rows whose files are still checked in", () => {
    const squashedManifest = `
## Individual Migrations (current active files)

None. The next migration starts at sequence 0228.

## Squashed Individual Migrations (absorbed into the 0000 baseline on 2026-07-30)

| Sequence | Filename | Description |
| --- | --- | --- |
| 0072 | \`0072_telegram_launch_alerts.sql\` | Add launch alerts |

## Retired Individual Migrations

| Sequence | Former Filename | Retirement Note |
| --- | --- | --- |
| 0086 | \`0086_treasury_stable_exposure_history.sql\` | Retired |

## Known Anomalies
`;
    expect(validateManifestMigrationParity(["0000_baseline.sql"], squashedManifest)).toEqual({
      activeManifestCount: 0,
      retiredManifestCount: 1,
    });
    expect(() =>
      validateManifestMigrationParity(["0000_baseline.sql", "0072_telegram_launch_alerts.sql"], squashedManifest),
    ).toThrow(/squashed manifest rows still have checked-in migration files|missing from the active manifest table/);
  });

  it("accepts one active manifest row per checked-in post-baseline migration", () => {
    expect(
      validateManifestMigrationParity(
        ["0000_baseline.sql", "0072_telegram_launch_alerts.sql", "0073_price_cache_provenance.sql"],
        manifestText,
      ),
    ).toEqual({
      activeManifestCount: 2,
      retiredManifestCount: 1,
    });
  });

  it("fails when a checked-in migration is missing from the active manifest table", () => {
    expect(() =>
      validateManifestMigrationParity(
        [
          "0000_baseline.sql",
          "0072_telegram_launch_alerts.sql",
          "0073_price_cache_provenance.sql",
          "0074_cron_slot_executions.sql",
        ],
        manifestText,
      ),
    ).toThrow("migration files missing from active manifest table: 0074_cron_slot_executions.sql");
  });

  it("fails when an active manifest row has no checked-in migration file", () => {
    expect(() =>
      validateManifestMigrationParity(["0000_baseline.sql", "0072_telegram_launch_alerts.sql"], manifestText),
    ).toThrow("active manifest rows without migration files: 0073_price_cache_provenance.sql");
  });

  it("fails when a retired migration file remains checked in", () => {
    expect(() =>
      validateManifestMigrationParity(
        [
          "0000_baseline.sql",
          "0072_telegram_launch_alerts.sql",
          "0073_price_cache_provenance.sql",
          "0086_treasury_stable_exposure_history.sql",
        ],
        manifestText,
      ),
    ).toThrow("retired manifest rows still have checked-in migration files");
  });

  it("requires the baseline independently of post-baseline parity", () => {
    expect(() => validateManifestMigrationParity(
      ["0072_telegram_launch_alerts.sql", "0073_price_cache_provenance.sql"],
      manifestText,
    )).toThrow("must include 0000_baseline.sql");
  });

  it("rejects a duplicate active row even when the filename sets match", () => {
    const duplicate = manifestText.replace(
      "## Retired Individual Migrations",
      "| 0072 | `0072_telegram_launch_alerts.sql` | Duplicate |\n\n## Retired Individual Migrations",
    );
    expect(() => validateManifestMigrationParity(
      ["0000_baseline.sql", "0072_telegram_launch_alerts.sql", "0073_price_cache_provenance.sql"],
      duplicate,
    )).toThrow("duplicate active manifest rows: 0072_telegram_launch_alerts.sql");
  });

  it("rejects sequence mismatches independently in every manifest section", () => {
    const withSquashed = manifestText.replace(
      "## Retired Individual Migrations",
      "## Squashed Individual Migrations\n\n| 0060 | `0060_old.sql` | Squashed |\n\n## Retired Individual Migrations",
    );
    const files = ["0000_baseline.sql", "0072_telegram_launch_alerts.sql", "0073_price_cache_provenance.sql"];
    expect(validateManifestMigrationParity(files, withSquashed)).toEqual({
      activeManifestCount: 2, retiredManifestCount: 1,
    });
    for (const [section, sequence, filename] of [
      ["active", "0072", "0072_telegram_launch_alerts.sql"],
      ["retired", "0086", "0086_treasury_stable_exposure_history.sql"],
      ["squashed", "0060", "0060_old.sql"],
    ]) {
      expect(() => validateManifestMigrationParity(
        files,
        withSquashed.replace(`| ${sequence} |`, "| 0999 |"),
      )).toThrow(`${section} manifest sequence/filename mismatches: 0999 -> ${filename}`);
    }
  });

  it("identifies an active migration also listed as retired", () => {
    expect(() => validateManifestMigrationParity(
      ["0000_baseline.sql", "0072_telegram_launch_alerts.sql", "0073_price_cache_provenance.sql"],
      manifestText.replace(
        "## Reviewed Data Migrations",
        "| 0072 | `0072_telegram_launch_alerts.sql` | Retired |\n\n## Reviewed Data Migrations",
      ),
    )).toThrow("migration rows listed as both active and retired: 0072_telegram_launch_alerts.sql");
  });
});

describe("validateDuplicatePrefixes", () => {
  it("rejects duplicate migration prefixes", () => {
    expect(() => validateDuplicatePrefixes(["0070_new_feature.sql", "0070_followup.sql"])).toThrow(
      "Duplicate migration sequence numbers: 0070",
    );
  });
});

describe("parseDataMigrationManifestRows", () => {
  it("reads every required review field", () => {
    expect(parseDataMigrationManifestRows(manifestText)).toEqual([
      {
        sequence: "0236",
        filename: "0236_dex_deployment_attempt_attribution.sql",
        predicate: "all outcome rows",
        oldWorkerCompatibility: "legacy readers ignore the nullable column",
        rollbackBookmark: "Time Travel bookmark before deploy",
        expectedRowBounds: "no more than the existing outcome row count",
      },
    ]);
  });
});

describe("schema object manifest", () => {
  it("serializes replayed objects deterministically by type and name", () => {
    expect(createSchemaObjectManifest(rows)).toBe("index\tidx_example_value\ntable\texample\n");
  });

  it("rejects checked-in manifest drift with both sides of the diff", () => {
    expect(() =>
      validateSchemaObjectManifest("table\tnew_table\n", "table\texpected_table\n"),
    ).toThrow(
      "unexpected fresh-replay objects: table\tnew_table\n- expected objects missing from fresh replay: table\texpected_table",
    );
  });
});

describe("validateRolloutSafetyPolicy", () => {
  it("accepts the frozen rollout-safety policy", () => {
    expect(() =>
      validateRolloutSafetyPolicy({
        enforcementPrefix: ROLLOUT_SAFETY_ENFORCEMENT_PREFIX,
        requiredMode: REQUIRED_ROLLOUT_SAFETY_MODE,
      }),
    ).not.toThrow();
  });

  it("rejects rollout-safety cutoff drift", () => {
    expect(() =>
      validateRolloutSafetyPolicy({
        enforcementPrefix: "0072",
        requiredMode: REQUIRED_ROLLOUT_SAFETY_MODE,
      }),
    ).toThrow("rollout-safety enforcement must stay frozen");
  });
});

describe("validateNoSqliteDotCommands", () => {
  it("rejects sqlite3 shell dot-commands before migration replay", () => {
    expect(() =>
      validateNoSqliteDotCommands(
        "0071_shell_command.sql",
        [
          `-- rollout-safety: ${REQUIRED_ROLLOUT_SAFETY_MODE}`,
          "CREATE TABLE example (id INTEGER PRIMARY KEY);",
          ".shell echo migration-rce",
        ].join("\n"),
      ),
    ).toThrow("contains a sqlite3 shell dot-command line");
  });

  it("accepts regular SQL and comments", () => {
    expect(() =>
      validateNoSqliteDotCommands(
        "0071_safe.sql",
        [
          `-- rollout-safety: ${REQUIRED_ROLLOUT_SAFETY_MODE}`,
          "-- .shell in a comment is documentation, not a sqlite3 metacommand",
          "CREATE TABLE example (id INTEGER PRIMARY KEY);",
        ].join("\n"),
      ),
    ).not.toThrow();
  });
});

describe("validateRolloutSafetyAnnotation", () => {
  it("does not require rollout-safety metadata for historical migrations before the cutoff", () => {
    expect(() =>
      validateRolloutSafetyAnnotation("0070_existing.sql", "CREATE TABLE example (id INTEGER);"),
    ).not.toThrow();
  });

  it("requires the rollout-safety header for new migrations", () => {
    expect(() => validateRolloutSafetyAnnotation("0071_new_table.sql", "CREATE TABLE example (id INTEGER);")).toThrow(
      'must declare "-- rollout-safety: backward-compatible"',
    );
  });

  it("rejects unsupported rollout-safety modes", () => {
    expect(() =>
      validateRolloutSafetyAnnotation("0071_cleanup.sql", "-- rollout-safety: cleanup\nDROP TABLE old_table;\n"),
    ).toThrow('only allow "backward-compatible" migrations');
  });

  it.each([
    ["DROP TABLE old_table;", "DROP TABLE"],
    ["ALTER TABLE example RENAME TO renamed;", "ALTER TABLE ... RENAME TO"],
    ["ALTER TABLE example RENAME COLUMN old TO renamed;", "ALTER TABLE ... RENAME COLUMN"],
    ["ALTER TABLE example DROP COLUMN old;", "ALTER TABLE ... DROP COLUMN"],
  ])("rejects the independently destructive operation %s", (sql, operation) => {
    expect(() =>
      validateRolloutSafetyAnnotation(
        "0071_replace_table.sql",
        `-- rollout-safety: backward-compatible\n${sql}`,
      ),
    ).toThrow(operation);
  });

  it("rejects DROP INDEX in new migrations with the coordinated cleanup path", () => {
    expect(() =>
      validateRolloutSafetyAnnotation(
        "0231_drop_index.sql",
        `-- rollout-safety: ${REQUIRED_ROLLOUT_SAFETY_MODE}\nDROP INDEX IF EXISTS idx_old_path;`,
      ),
    ).toThrow("separate rollout path and coordinated cleanup process");
  });

  it("grandfathers DROP INDEX through the migration that introduced the gate", () => {
    expect(() =>
      validateRolloutSafetyAnnotation(
        `${String(DROP_INDEX_GRANDFATHER_THROUGH_SEQUENCE).padStart(4, "0")}_existing_drop_index.sql`,
        `-- rollout-safety: ${REQUIRED_ROLLOUT_SAFETY_MODE}\nDROP INDEX IF EXISTS idx_old_path;`,
      ),
    ).not.toThrow();
  });

  it("rejects new NOT NULL columns that would break still-live writes without a default", () => {
    for (const addColumnStatement of [
      "ALTER TABLE api_keys ADD COLUMN owner_team TEXT NOT NULL;",
      "ALTER TABLE api_keys ADD owner_team TEXT NOT NULL;",
      ["ALTER TABLE api_keys", "  ADD owner_team TEXT NOT NULL", "  CHECK (length(owner_team) > 0);"].join("\n"),
    ]) {
      expect(() =>
        validateRolloutSafetyAnnotation(
          "0071_add_required_column.sql",
          [`-- rollout-safety: ${REQUIRED_ROLLOUT_SAFETY_MODE}`, addColumnStatement].join("\n"),
        ),
      ).toThrow(UNSAFE_ROLLOUT_ADD_COLUMN_LABEL);
    }
  });

  it.each([
    ["DELETE FROM cron_runs WHERE started_at < 1;", "DELETE FROM"],
    ["UPDATE cron_runs SET status = 'ok' WHERE id = 1;", "UPDATE"],
    ["INSERT OR REPLACE INTO cron_runs (id, job, started_at, duration_ms, status) VALUES (1, 'x', 1, 0, 'ok');", "INSERT OR REPLACE"],
  ])("rejects %s without reviewed data-migration metadata", (statement, operation) => {
    expect(() =>
      validateRolloutSafetyAnnotation(
        "0244_data_change.sql",
        `-- rollout-safety: ${REQUIRED_ROLLOUT_SAFETY_MODE}\n${statement}`,
      ),
    ).toThrow(operation);
  });

  it("keeps the reviewed 0236 data migration grandfathered", () => {
    const repositoryManifest = readFileSync(resolve("worker/migrations/MANIFEST.md"), "utf8");
    const migration = readFileSync(
      resolve("worker/migrations/0236_dex_deployment_attempt_attribution.sql"),
      "utf8",
    );
    expect(() =>
      validateRolloutSafetyAnnotation(
        "0236_dex_deployment_attempt_attribution.sql",
        migration,
        ROLLOUT_SAFETY_ENFORCEMENT_PREFIX,
        parseDataMigrationManifestRows(repositoryManifest),
      ),
    ).not.toThrow();
  });

  it("accepts additive migrations with the required rollout-safety header", () => {
    expect(() =>
      validateRolloutSafetyAnnotation(
        "0071_new_table.sql",
        [
          "-- cleanup later: DROP TABLE old_table",
          `-- rollout-safety: ${REQUIRED_ROLLOUT_SAFETY_MODE}`,
          "CREATE TABLE example (id INTEGER PRIMARY KEY, value TEXT);",
          "ALTER TABLE example ADD COLUMN display_name TEXT NOT NULL DEFAULT '';",
          "CREATE INDEX idx_example_value ON example(value);",
        ].join("\n"),
      ),
    ).not.toThrow();
  });
});

describe("seeded data-migration replay", () => {
  it("rejects an unannotated DELETE and accepts its reviewed manifest entry against existing rows", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pharos-migration-gate-test-"));
    const migrationsDir = join(tempDir, "migrations");
    const manifestPath = join(tempDir, "MANIFEST.md");
    const expectedSchemaPath = join(tempDir, "EXPECTED_SCHEMA.txt");
    mkdirSync(migrationsDir);
    writeFileSync(
      join(migrationsDir, "0000_baseline.sql"),
      "CREATE TABLE cron_runs (id INTEGER PRIMARY KEY, job TEXT NOT NULL, started_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL, status TEXT NOT NULL);",
    );
    writeFileSync(expectedSchemaPath, "table\tcron_runs\n");
    writeFileSync(
      manifestPath,
      `
## Individual Migrations
| Sequence | Filename | Description |
| --- | --- | --- |
| 0071 | \`0071_delete_cron_runs.sql\` | Reviewed fixture cleanup |
## Retired Individual Migrations
| Sequence | Former Filename | Retirement Note |
| --- | --- | --- |
| 0086 | \`0086_retired.sql\` | Retired |
## Reviewed Data Migrations
| Sequence | Filename | Predicate | Old-Worker compatibility | Rollback / bookmark | Expected row bounds |
| --- | --- | --- | --- | --- | --- |
| 0071 | \`0071_delete_cron_runs.sql\` | fixture job only | old Worker does not require fixture rows | capture a Time Travel bookmark | zero or one fixture row |
## Known Anomalies
## Rollout Safety
- Rollout-safety enforcement starts at: \`0071\`
- Required rollout-safety header: \`-- rollout-safety: backward-compatible\`
`,
    );
    const migrationPath = join(migrationsDir, "0071_delete_cron_runs.sql");
    const deleteStatement = "DELETE FROM cron_runs WHERE job = 'migration-gate-fixture';";

    try {
      writeFileSync(
        migrationPath,
        `-- rollout-safety: ${REQUIRED_ROLLOUT_SAFETY_MODE}\n${deleteStatement}\n`,
      );
      await expect(
        validateWorkerMigrations({ migrationsDir, manifestPath, expectedSchemaPath }),
      ).rejects.toThrow(`-- data-migration: ${REQUIRED_DATA_MIGRATION_MODE}`);

      writeFileSync(
        migrationPath,
        [
          `-- rollout-safety: ${REQUIRED_ROLLOUT_SAFETY_MODE}`,
          `-- data-migration: ${REQUIRED_DATA_MIGRATION_MODE}`,
          deleteStatement,
          "",
        ].join("\n"),
      );
      await expect(
        validateWorkerMigrations({ migrationsDir, manifestPath, expectedSchemaPath }),
      ).resolves.toMatchObject({ dataMigrationFixtureCheckedCount: 1 });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("replays grandfathered migration 0236 against the repository fixture", async () => {
    await expect(validateWorkerMigrations()).resolves.toMatchObject({
      dataMigrationFixtureCheckedCount: 1,
    });
  });
});