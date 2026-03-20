import { describe, expect, it } from "vitest";

import {
  parseDuplicatePrefixAllowlist,
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
