import { describe, expect, it } from "vitest";

import {
  REQUIRED_ROLLOUT_SAFETY_MODE,
  ROLLOUT_SAFETY_ENFORCEMENT_PREFIX,
  UNSAFE_ROLLOUT_ADD_COLUMN_LABEL,
  DROP_INDEX_GRANDFATHER_THROUGH_SEQUENCE,
  createSchemaFingerprint,
  parseManifestMigrationRows,
  parseRolloutSafetyPolicy,
  validateManifestMigrationParity,
  validateNoSqliteDotCommands,
  validateDuplicatePrefixes,
  validateRolloutSafetyAnnotation,
  validateRolloutSafetyPolicy,
} from "../ci/check-worker-migrations.ts";

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

## Known Anomalies
`;

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

## Known Anomalies
`;

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
});

describe("validateDuplicatePrefixes", () => {
  it("rejects duplicate migration prefixes", () => {
    expect(() => validateDuplicatePrefixes(["0070_new_feature.sql", "0070_followup.sql"])).toThrow(
      "Duplicate migration sequence numbers: 0070",
    );
  });
});

describe("createSchemaFingerprint", () => {
  it("produces a deterministic digest from normalized schema rows", () => {
    const rows = [
      {
        type: "index",
        name: "idx_example_value",
        tblName: "example",
        sql: "CREATE INDEX idx_example_value\nON example(value)",
      },
      {
        type: "table",
        name: "example",
        tblName: "example",
        sql: "CREATE TABLE example (id INTEGER PRIMARY KEY, value TEXT)",
      },
    ];

    expect(createSchemaFingerprint(rows)).toEqual(createSchemaFingerprint([...rows].reverse()));
    expect(createSchemaFingerprint(rows)).toMatchObject({
      algorithm: "sha256",
      schemaRowCount: 2,
    });
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

  it("rejects destructive rename or drop statements for new backward-compatible migrations", () => {
    expect(() =>
      validateRolloutSafetyAnnotation(
        "0071_replace_table.sql",
        "-- rollout-safety: backward-compatible\nDROP TABLE old_table;\nALTER TABLE new_table RENAME TO old_table;\n",
      ),
    ).toThrow("can break the still-live worker");
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
