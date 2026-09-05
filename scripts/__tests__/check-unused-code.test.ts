import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const CHECKER = resolve(process.cwd(), "scripts/ci/check-unused-code.ts");
const TSX_LOADER = resolve(process.cwd(), "node_modules/tsx/dist/loader.mjs");

let workspace: string | undefined;

/**
 * The checker reads `process.cwd()` as its scan root, so a fixture tree plus a
 * subprocess exercises the real scanner rather than a reimplementation of it.
 * It resolves aliases from `vitest.config.ts` and audits the shared allowlist,
 * so the fixture must supply both to reach the scan itself.
 */
const SCAFFOLD: Record<string, string> = {
  "vitest.config.ts":
    'import path from "node:path";\n' +
    "export default {\n" +
    "  resolve: {\n" +
    "    alias: {\n" +
    '      "@": path.resolve(__dirname, "src"),\n' +
    '      "@shared": path.resolve(__dirname, "shared"),\n' +
    "    },\n" +
    "  },\n" +
    "};\n",
  "src/test/setup.ts": "export {};\n",
  "shared/data/safety-score-v9/evaluation-build-manifest-v1.ts":
    "export const SAFETY_SCORE_V9_EVALUATION_BUILD_MANIFEST = { id: 1 };\n",
  "src/components/chart-primitives/data-table.tsx": "export const ChartDataTable = 1;\n",
};

function runChecker(
  files: Record<string, string>,
  args: string[] = [],
  scaffold: Record<string, string> = SCAFFOLD,
): { status: number; output: string } {
  workspace = mkdtempSync(join(tmpdir(), "pharos-unused-code-"));
  for (const [relativePath, contents] of Object.entries({ ...scaffold, ...files })) {
    const absolute = join(workspace, relativePath);
    mkdirSync(resolve(absolute, ".."), { recursive: true });
    writeFileSync(absolute, contents);
  }

  try {
    const output = execFileSync(process.execPath, ["--import", TSX_LOADER, CHECKER, ...args], {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = undefined;
});

describe("check-unused-code export resolution", () => {
  it("credits a named use that reaches the declaring module through a wildcard re-export", () => {
    // `used` is imported from the barrel, never from its declaring module. The
    // scan must follow `export *` back to the owner, while the sibling export
    // that nothing imports is still reported.
    const { status, output } = runChecker({
      "shared/owner.ts": "export const used = 1;\nexport const neverImported = 2;\n",
      "shared/barrel.ts": 'export * from "./owner";\n',
      "src/app/page.tsx": 'import { used } from "../../shared/barrel";\nexport const entry = used;\n',
    });

    expect(output).toContain("shared/owner.ts :: neverImported");
    expect(output).not.toContain("shared/owner.ts :: used");
    expect(status).toBe(1);
  });

  it("credits a used type-only specifier in a mixed export clause", () => {
    // `export { fn, type Shape }` marks only `Shape` type-only. The type export
    // is used by the entrypoint, so it should be credited without becoming a
    // runtime export finding.
    const { output } = runChecker({
      "shared/decls.ts":
        "export type Shape = { a: number };\n" +
        "export const unusedConst = 1;\n" +
        "export function fn(): number {\n  return 1;\n}\n",
      "shared/mixed.ts": 'export { fn, type Shape } from "./decls";\n',
      "src/app/page.tsx":
        'import { fn } from "../../shared/mixed";\n' +
        'import type { Shape } from "../../shared/mixed";\n' +
        "const shape: Shape = { a: 1 };\n" +
        "export const entry = fn() + shape.a;\n",
    });

    // Positive control: a genuinely unused runtime export in the same module is
    // reported, so the absence of `Shape` confirms the type-use edge was seen.
    expect(output).toContain("shared/decls.ts :: unusedConst");
    expect(output).not.toContain("Shape");
    expect(output).not.toContain(":: fn");
  });

  it("reports unused direct type aliases and interfaces", () => {
    const { status, output } = runChecker({
      "shared/types.ts":
        "export type UsedShape = { a: number };\n" +
        "export interface NeverUsed { b: string }\n" +
        "export type LocalShape = { c: boolean };\n" +
        "const localShape: LocalShape = { c: true };\n",
      "src/app/page.tsx":
        'import type { UsedShape } from "../../shared/types";\n' +
        "const shape: UsedShape = { a: 1 };\n" +
        "export const entry = shape.a;\n",
    });

    expect(output).toContain("shared/types.ts :: NeverUsed");
    expect(output).not.toContain("shared/types.ts :: UsedShape");
    expect(output).not.toContain("shared/types.ts :: LocalShape");
    expect(status).toBe(1);
  });

  it("follows typed import queries to their named exports", () => {
    const minimalScaffold = { "vitest.config.ts": SCAFFOLD["vitest.config.ts"] };
    const { status, output } = runChecker({
      "shared/type-owner.ts": "export interface UsedThroughQuery { value: number }\n",
      "shared/type-query.ts":
        'export type QueryResult = import("./type-owner").UsedThroughQuery;\n',
      "src/app/page.tsx":
        'import type { QueryResult } from "../../shared/type-query";\n' +
        "const result: QueryResult = { value: 1 };\n" +
        "export const entry = result.value;\n",
    }, ["--skip-allowlist-audit"], minimalScaffold);

    expect(output).not.toContain("shared/type-owner.ts :: UsedThroughQuery");
    expect(output).not.toContain("shared/type-query.ts :: QueryResult");
    expect(status).toBe(0);
  });
});

describe("check-unused-code production reachability", () => {
  const minimalScaffold = { "vitest.config.ts": SCAFFOLD["vitest.config.ts"] };
  const skipAudit = ["--skip-allowlist-audit"];

  it("reports a production helper only tests import as dead, including through test-only re-exports", () => {
    // Tests are not consumers: a module whose only importers are test files is
    // dead product code, and a non-test barrel that only tests import must not
    // transitively vouch for what it re-exports.
    const { status, output } = runChecker(
      {
        "src/lib/test-only-helper.ts": "export const helper = 1;\n",
        "src/lib/__tests__/helper.test.ts":
          'import { helper } from "../test-only-helper";\n\ntest("helper", () => helper);\n',
        "src/lib/test-only-barrel.ts": 'export { victimValue } from "../../shared/victim";\n',
        "src/lib/__tests__/barrel.test.ts":
          'import { victimValue } from "../test-only-barrel";\n\ntest("victim", () => victimValue);\n',
        "shared/victim.ts": "export const victimValue = 1;\n",
      },
      skipAudit,
      minimalScaffold,
    );

    expect(output).toContain("src/lib/test-only-helper.ts (only referenced by tests or test fixtures)");
    expect(output).toContain("src/lib/test-only-barrel.ts (only referenced by tests or test fixtures)");
    expect(output).toContain(
      "shared/victim.ts (only referenced from modules that are not production-reachable)",
    );
    expect(status).toBe(1);
  });

  it("keeps a production import and re-export chain from a framework root live", () => {
    const { status, output } = runChecker(
      {
        "src/app/page.tsx":
          'import { chainValue } from "@/lib/chain-entry";\n' +
          'import { ChainWidget } from "@/components/chain-widget";\n' +
          "export default function Page() {\n  return <ChainWidget value={chainValue} />;\n}\n",
        "src/lib/chain-entry.ts": 'export { chainValue } from "../../shared/chain-owner";\n',
        "shared/chain-owner.ts": "export const chainValue = 1;\n",
        "src/components/chain-widget.tsx":
          'import { chainValue } from "../../shared/chain-owner";\n' +
          "export function ChainWidget({ value }: { value: number }) {\n  return value + chainValue;\n}\n",
      },
      skipAudit,
      minimalScaffold,
    );

    expect(output).toContain("No dead internal modules or unused named exports found.");
    expect(status).toBe(0);
  });

  it("treats Next.js filename conventions as roots but not arbitrary app helpers", () => {
    const { status, output } = runChecker(
      {
        "src/app/page.tsx": "export default function Page() {\n  return null;\n}\n",
        "src/app/api/health/route.ts": 'export async function GET() {\n  return new Response("ok");\n}\n',
        "src/app/local-helper.ts": "export const local = 1;\n",
        "src/app/__tests__/local-helper.test.ts":
          'import { local } from "../local-helper";\n\ntest("local", () => local);\n',
      },
      skipAudit,
      minimalScaffold,
    );

    expect(output).toContain("src/app/local-helper.ts (only referenced by tests or test fixtures)");
    expect(output).not.toContain("src/app/page.tsx");
    expect(output).not.toContain("src/app/api/health/route.ts");
    expect(status).toBe(1);
  });

  it("keeps a workflow-named script entrypoint and its import chain live", () => {
    // The shock-coverage-refresh.yml pattern: the workflow names a scripts/**
    // file as a `node --import tsx` command target via the reused
    // check-script-entrypoints extractor. It and everything it imports stay
    // live, while an unreferenced production sibling with only a test importer
    // dies. (Command recognition is prefix-bound to scripts/** by the reused
    // extractor's contract; workflow references to reportable modules go
    // through embedded import expressions, covered by their own test.)
    const { status, output } = runChecker(
      {
        ".github/workflows/manual-probe.yml":
          "jobs:\n  probe:\n    steps:\n      - run: " + "node --import tsx " + "scripts/smoke/live-probe.ts\n",
        "scripts/smoke/live-probe.ts":
          'import { probeValue } from "../../shared/probe-value";\n\nconsole.log(probeValue);\n',
        "shared/probe-value.ts": "export const probeValue = 1;\n",
        "worker/src/cron/orphan-probe.ts": "export const orphan = 2;\n",
        "worker/src/lib/__tests__/orphan-probe.test.ts":
          'import { orphan } from "../../cron/orphan-probe";\n\ntest("orphan", () => orphan);\n',
      },
      skipAudit,
      minimalScaffold,
    );

    expect(output).toContain("worker/src/cron/orphan-probe.ts (only referenced by tests or test fixtures)");
    expect(output).not.toContain("scripts/smoke/live-probe.ts");
    expect(output).not.toContain("shared/probe-value.ts");
    expect(status).toBe(1);
  });

  it("preserves test-support fixtures while their edges cannot vouch", () => {
    const { output } = runChecker(
      {
        "src/test-utils/frontend.ts": "export const mockMatchMedia = () => true;\n",
        "src/test/json-ld.ts": 'export const jsonLd = "{}";\n',
        "src/components/__tests__/widget.test.tsx":
          'import { mockMatchMedia } from "../../../test-utils/frontend";\n' +
          'import { jsonLd } from "../../../test/json-ld";\n' +
          'test("widget", () => {\n  mockMatchMedia();\n  jsonLd;\n});\n',
        "src/lib/test-only.ts": "export const kept = 1;\n",
        "src/test-utils/importer-side.ts":
          'import { kept } from "../lib/test-only";\n\nexport const side = kept;\n',
      },
      skipAudit,
      minimalScaffold,
    );

    expect(output).not.toContain("src/test-utils/frontend.ts");
    expect(output).not.toContain("src/test/json-ld.ts");
    expect(output).not.toContain("src/test-utils/importer-side.ts");
    expect(output).toContain("src/lib/test-only.ts (only referenced by tests or test fixtures)");
  });
});

describe("check-unused-code string-reference recognition", () => {
  const minimalScaffold = { "vitest.config.ts": SCAFFOLD["vitest.config.ts"] };
  const skipAudit = ["--skip-allowlist-audit"];

  it("does not root modules mentioned only in registry metadata or comments", () => {
    // A path that appears as a bare token — an automation registry's
    // sourcePaths metadata or a comment — is not a consumer.
    const { status, output } = runChecker(
      {
        "scripts/lib/coverage-candidates.ts":
          "export const coverageCandidates = {\n" +
          '  sourcePaths: ["src/lib/metadata-kept.ts"],\n' +
          "};\n" +
          "// TODO: revisit src/lib/comment-kept.ts after the migration.\n",
        "src/lib/metadata-kept.ts": "export const metadataKept = 1;\n",
        "src/lib/__tests__/metadata-kept.test.ts":
          'import { metadataKept } from "../metadata-kept";\n\ntest("m", () => metadataKept);\n',
        "src/lib/comment-kept.ts": "export const commentKept = 2;\n",
      },
      skipAudit,
      minimalScaffold,
    );

    expect(output).toContain("src/lib/metadata-kept.ts (only referenced by tests or test fixtures)");
    expect(output).toContain("src/lib/comment-kept.ts (unreferenced module or dead shim)");
    expect(status).toBe(1);
  });

  it("does not root modules named by quoted imports in comments, metadata, or script text", () => {
    // Import-shaped syntax that is not executed: shell `#` and script `//`
    // comment lines inside a run body, a workflow env value, and a commented
    // import in script source. None of these may keep a module alive.
    const { status, output } = runChecker(
      {
        ".github/workflows/probe.yml":
          "jobs:\n" +
          "  probe:\n" +
          "    steps:\n" +
          "      - run: |\n" +
          "          # node --import tsx shared/lib/shell-comment-kept.ts\n" +
          '          // import { x } from "./shared/lib/js-comment-kept.ts";\n' +
          "          node --version\n",
        ".github/workflows/other.yml":
          "env:\n" +
          '  SNIPPET: "import(\'./shared/lib/env-metadata-kept.ts\')"\n' +
          "jobs: {}\n",
        "scripts/lib/notes.ts": '// import("./shared/lib/script-comment-kept.ts")\nexport const notes = 1;\n',
        "shared/lib/shell-comment-kept.ts": "export const a = 1;\n",
        "shared/lib/js-comment-kept.ts": "export const b = 2;\n",
        "shared/lib/env-metadata-kept.ts": "export const c = 3;\n",
        "shared/lib/script-comment-kept.ts": "export const d = 4;\n",
      },
      skipAudit,
      minimalScaffold,
    );

    expect(output).toContain("shared/lib/shell-comment-kept.ts");
    expect(output).toContain("shared/lib/js-comment-kept.ts");
    expect(output).toContain("shared/lib/env-metadata-kept.ts");
    expect(output).toContain("shared/lib/script-comment-kept.ts");
    expect(status).toBe(1);
  });

  it("roots a module imported by an embedded workflow import expression", () => {
    // deploy-cloudflare.yml-style heredoc: an actual import statement embedded
    // in a workflow run step. The imported reportable module is live even
    // though nothing in the repo imports it.
    const { output } = runChecker(
      {
        ".github/workflows/accept.yml":
          "jobs:\n" +
          "  verify:\n" +
          "    steps:\n" +
          "      - run: |\n" +
          "          node --input-type=module <<'NODE'\n" +
          '          import { probeImported } from "./worker/src/lib/workflow-imported.ts";\n' +
          "          NODE\n",
        "worker/src/lib/workflow-imported.ts": "export const probeImported = 1;\n",
        "worker/src/lib/unreferenced-sibling.ts": "export const sibling = 2;\n",
      },
      skipAudit,
      minimalScaffold,
    );

    expect(output).not.toContain("worker/src/lib/workflow-imported.ts");
    expect(output).toContain("worker/src/lib/unreferenced-sibling.ts");
  });
});

describe("check-unused-code definition-site waiver propagation", () => {
  const minimalScaffold = { "vitest.config.ts": SCAFFOLD["vitest.config.ts"] };

  it("covers waived re-export hops while unwaived barrel exports stay reported", () => {
    // Mirrors the canonical Mini App surface: the checker's real allowlist
    // waives TelegramDewsBand/TelegramSafetyMode on their defining contract
    // module (external consumers), and the src/app type barrel re-exports them
    // for that audience. The waiver must reach the hop, while an unwaived
    // re-export and a barrel-local export in the same file are still findings.
    // The barrel stays production-live through the page import; the waived
    // names are deliberately not imported from it anywhere.
    const { status, output } = runChecker(
      {
        "shared/lib/telegram-mini-app-contract.ts":
          'export type TelegramDewsBand = "ALERT" | "WARNING" | "DANGER";\n' +
          'export type TelegramSafetyMode = "standard" | "quiet";\n' +
          "export type UnwaivedContractType = { x: number };\n",
        "src/app/pharoswatchbot/app/types.ts":
          'export type { TelegramDewsBand, TelegramSafetyMode, UnwaivedContractType } from "@shared/lib/telegram-mini-app-contract";\n' +
          "export type LocalBarrelType = { y: number };\n" +
          "export type UsedBarrelType = { z: number };\n",
        "src/app/pharoswatchbot/app/page.tsx":
          'import type { UsedBarrelType } from "./types";\n' +
          "const local: UsedBarrelType = { z: 1 };\n" +
          "export default function Page() {\n  return local.z;\n}\n",
      },
      ["--skip-allowlist-audit"],
      minimalScaffold,
    );

    expect(output).not.toContain("shared/lib/telegram-mini-app-contract.ts :: TelegramSafetyMode");
    expect(output).not.toContain("src/app/pharoswatchbot/app/types.ts :: TelegramDewsBand");
    expect(output).not.toContain("src/app/pharoswatchbot/app/types.ts :: TelegramSafetyMode");
    expect(output).toContain("src/app/pharoswatchbot/app/types.ts :: UnwaivedContractType");
    expect(output).toContain("src/app/pharoswatchbot/app/types.ts :: LocalBarrelType");
    expect(output).toContain("shared/lib/telegram-mini-app-contract.ts :: UnwaivedContractType");
    expect(status).toBe(1);
  });
});
