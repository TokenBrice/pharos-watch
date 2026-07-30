import { describe, expect, it } from "vitest";

import {
  LEGACY_DUPLICATE_PREFIX_ALLOWLIST,
  REQUIRED_ROLLOUT_SAFETY_MODE,
  ROLLOUT_SAFETY_ENFORCEMENT_PREFIX,
  UNSAFE_ROLLOUT_ADD_COLUMN_LABEL,
  createSchemaFingerprint,
  parseManifestMigrationRows,
  parseDuplicatePrefixAllowlist,
  parseRolloutSafetyPolicy,
  validateManifestMigrationParity,
  validateDuplicatePrefixAllowlist,
  validateNoSqliteDotCommands,
  validateDuplicatePrefixes,
  validateRolloutSafetyAnnotation,
  validateRolloutSafetyPolicy,
} from "../ci/check-worker-migrations.mjs";

describe("parseDuplicatePrefixAllowlist", () => {
  it("reads the legacy duplicate allowlist from the manifest text", () => {
    const allowlist = parseDuplicatePrefixAllowlist(`
## Known Anomalies

- Duplicate-prefix allowlist: \`0056\`, \`0061\`
`);

    expect([...allowlist]).toEqual(["0056", "0061"]);
  });
});

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
  it("suppresses the historical duplicate prefixes from the manifest allowlist", () => {
    const { uniqueDuplicates, newDuplicates } = validateDuplicatePrefixes(
      ["0056_one.sql", "0056_two.sql", "0061_one.sql", "0061_two.sql"],
      new Set(["0056", "0061"]),
    );

    expect(uniqueDuplicates).toEqual(["0056", "0061"]);
    expect(newDuplicates).toEqual([]);
  });

  it("flags a newly introduced duplicate prefix outside the allowlist", () => {
    const { uniqueDuplicates, newDuplicates } = validateDuplicatePrefixes(
      ["0070_new_feature.sql", "0070_followup.sql"],
      new Set(["0056", "0061"]),
    );

    expect(uniqueDuplicates).toEqual(["0070"]);
    expect(newDuplicates).toEqual(["0070"]);
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

describe("validateDuplicatePrefixAllowlist", () => {
  it("accepts the frozen legacy duplicate-prefix allowlist", () => {
    expect(() => validateDuplicatePrefixAllowlist(new Set(LEGACY_DUPLICATE_PREFIX_ALLOWLIST))).not.toThrow();
  });

  it("rejects allowlist expansion beyond the frozen legacy prefixes", () => {
    expect(() => validateDuplicatePrefixAllowlist(new Set(["0056", "0061", "0070"]))).toThrow(
      "duplicate-prefix allowlist must stay frozen",
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

  it("rejects destructive rename or drop statements for new backward-compatible migrations", () => {
    expect(() =>
      validateRolloutSafetyAnnotation(
        "0071_replace_table.sql",
        "-- rollout-safety: backward-compatible\nDROP TABLE old_table;\nALTER TABLE new_table RENAME TO old_table;\n",
      ),
    ).toThrow("can break the still-live worker");
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
