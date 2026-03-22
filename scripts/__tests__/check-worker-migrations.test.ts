import { describe, expect, it } from "vitest";

import {
  LEGACY_DUPLICATE_PREFIX_ALLOWLIST,
  parseDuplicatePrefixAllowlist,
  validateDuplicatePrefixAllowlist,
  validateDuplicatePrefixes,
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

describe("validateDuplicatePrefixes", () => {
  it("suppresses the historical duplicate prefixes from the manifest allowlist", () => {
    const { uniqueDuplicates, newDuplicates } = validateDuplicatePrefixes(
      [
        "0056_one.sql",
        "0056_two.sql",
        "0061_one.sql",
        "0061_two.sql",
      ],
      new Set(["0056", "0061"]),
    );

    expect(uniqueDuplicates).toEqual(["0056", "0061"]);
    expect(newDuplicates).toEqual([]);
  });

  it("flags a newly introduced duplicate prefix outside the allowlist", () => {
    const { uniqueDuplicates, newDuplicates } = validateDuplicatePrefixes(
      [
        "0070_new_feature.sql",
        "0070_followup.sql",
      ],
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
