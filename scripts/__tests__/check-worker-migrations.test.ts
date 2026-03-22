import { describe, expect, it } from "vitest";

import {
  LEGACY_DUPLICATE_PREFIX_ALLOWLIST,
  REQUIRED_ROLLOUT_SAFETY_MODE,
  ROLLOUT_SAFETY_ENFORCEMENT_PREFIX,
  parseDuplicatePrefixAllowlist,
  parseRolloutSafetyPolicy,
  validateDuplicatePrefixAllowlist,
  validateDuplicatePrefixes,
  validateRolloutSafetyAnnotation,
  validateRolloutSafetyPolicy,
} from "../check-worker-migrations.mjs";

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

  it("accepts additive migrations with the required rollout-safety header", () => {
    expect(() =>
      validateRolloutSafetyAnnotation(
        "0071_new_table.sql",
        [
          "-- cleanup later: DROP TABLE old_table",
          `-- rollout-safety: ${REQUIRED_ROLLOUT_SAFETY_MODE}`,
          "CREATE TABLE example (id INTEGER PRIMARY KEY, value TEXT);",
          "CREATE INDEX idx_example_value ON example(value);",
        ].join("\n"),
      ),
    ).not.toThrow();
  });
});
