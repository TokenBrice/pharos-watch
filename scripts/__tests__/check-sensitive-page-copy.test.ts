import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkSensitivePageCopy, collectSensitiveCopyFindings } from "../ci/check-sensitive-page-copy";
import { withTempRepo } from "./helpers/test-state";

describe("sensitive page copy", () => {
  it("reports the same collected files in the passing scan count", () => {
    withTempRepo("pharos-sensitive-copy", {
      "pages/first.tsx": "export const copy = 'Funding information';",
      "pages/nested/second.css": ".safe { color: white; }",
      "pages/__tests__/ignored.tsx": "export const copy = 'connect wallet';",
      "pages/ignored.json": "{\"copy\":\"connect wallet\"}",
      "outside/page.tsx": "export const copy = 'connect wallet';",
    }, (cwd) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      expect(checkSensitivePageCopy({
        roots: ["pages", "missing"], cwd,
        stdout: { write: (text) => stdout.push(text) },
        stderr: { write: (text) => stderr.push(text) },
      })).toBe(0);
      expect(stdout.join("")).toContain("2 files scanned");
      expect(stderr).toEqual([]);
    });
  });

  it("preserves comment exclusion, multiline detection, line numbers, and duplicate suppression", () => {
    withTempRepo("pharos-sensitive-copy", {
      "pages/page.tsx": [
        "// connect wallet is forbidden in authored copy",
        "const first = 'connect wallet';",
        "const second = `claim",
        "your tokens`;",
      ].join("\n"),
    }, (cwd) => {
      expect(collectSensitiveCopyFindings([join(cwd, "pages/page.tsx")], cwd)).toMatchObject([
        { file: "pages/page.tsx", line: 2, id: "connect-wallet", term: "connect wallet" },
        { file: "pages/page.tsx", line: 3, id: "claim-or-airdrop", term: "claim your tokens" },
      ]);
      const stderr: string[] = [];
      expect(checkSensitivePageCopy({
        roots: ["pages"], cwd,
        stdout: { write: () => { throw new Error("Unexpected passing output"); } },
        stderr: { write: (text) => stderr.push(text) },
      })).toBe(1);
      expect(stderr.join("")).toContain("pages/page.tsx:2 [connect-wallet]");
      expect(stderr.join("")).toContain("pages/page.tsx:3 [claim-or-airdrop]");
    });
  });
});
