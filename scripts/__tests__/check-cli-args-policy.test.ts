import { describe, expect, it } from "vitest";

import { evaluateCliArgsPolicy, sourceUsesProcessArgv } from "../ci/check-cli-args-policy.ts";

const EXEMPTION_REASON = "Reads repository state and reports findings without persistent mutation.";

function createSourceReader(sources: Record<string, string>) {
  return (path: string): string => {
    const source = sources[path];
    if (source === undefined) throw new Error(`Missing fixture source: ${path}`);
    return source;
  };
}

describe("check-cli-args-policy", () => {
  it("discovers actual argv access without matching comments or strings", () => {
    expect(sourceUsesProcessArgv('const label = "process.argv"; // process.argv\n')).toBe(false);
    expect(sourceUsesProcessArgv("const args = process.argv.slice(2);\n")).toBe(true);
    expect(sourceUsesProcessArgv('const args = process["argv"].slice(2);\n')).toBe(true);
  });

  it("rejects a newly discovered process.argv entrypoint until it is classified", () => {
    const result = evaluateCliArgsPolicy({
      discoveredPaths: ["scripts/maintenance/new-operator.mjs"],
      policy: { strict: [], exemptions: [] },
      readSource: createSourceReader({}),
    });

    expect(result.errors).toContain("Unclassified process.argv entrypoint: scripts/maintenance/new-operator.mjs");
  });

  it("rejects strict declarations whose parser does not use the shared wrapper", () => {
    const path = "scripts/maintenance/operator.mjs";
    const result = evaluateCliArgsPolicy({
      discoveredPaths: [path],
      policy: {
        strict: [{ path, parserPath: path }],
        exemptions: [],
      },
      readSource: createSourceReader({
        [path]: "const args = process.argv.slice(2);\n",
      }),
    });

    expect(result.errors).toContain(
      `Strict parser ${path} must import scripts/lib/cli-args.mjs and call parseStrictCliArgs().`,
    );
  });

  it("rejects a parser declaration that is not reachable from the entrypoint", () => {
    const entrypoint = "scripts/maintenance/operator.mjs";
    const parserPath = "scripts/lib/operator-parser.mjs";
    const result = evaluateCliArgsPolicy({
      discoveredPaths: [entrypoint],
      policy: {
        strict: [{ path: entrypoint, parserPath }],
        exemptions: [],
      },
      readSource: createSourceReader({
        [entrypoint]: "process.stdout.write(process.argv.join(' '));\n",
        [parserPath]: [
          'import { parseStrictCliArgs } from "./cli-args.mjs";',
          "export const parse = (argv) => parseStrictCliArgs(argv);",
        ].join("\n"),
      }),
    });

    expect(result.errors).toContain(
      `Strict CLI entrypoint ${entrypoint} does not import its declared parser ${parserPath}.`,
    );
  });

  it("accepts direct and transitive strict parsers through cycles and extension resolution", () => {
    const path = "scripts/maintenance/operator.mjs";
    const parserPath = "scripts/lib/operator-parser.ts";
    const parser = 'import { parseStrictCliArgs } from "./cli-args.mjs"; export const parse = (argv) => parseStrictCliArgs(argv);';
    for (const direct of [true, false]) {
      const result = evaluateCliArgsPolicy({
        discoveredPaths: [path],
        policy: { strict: [{ path, parserPath: direct ? path : parserPath }], exemptions: [] },
        readSource: createSourceReader({
          [path]: direct ? parser.replace("./cli-args", "../lib/cli-args") : 'import "../lib/bridge"; process.argv;',
          "scripts/lib/bridge.mjs": 'import "../maintenance/operator.mjs"; export { parse } from "./operator-parser.js";',
          [parserPath]: parser,
        }),
      });
      expect(result.errors).toEqual([]);
    }
  });

  it.each(["comment", "string"])("rejects wrapper import and call spoofed in a %s", (kind) => {
    const path = "scripts/maintenance/operator.mjs";
    const spoof = 'import { parseStrictCliArgs } from "../lib/cli-args.mjs"; parseStrictCliArgs(process.argv);';
    const result = evaluateCliArgsPolicy({
      discoveredPaths: [path],
      policy: { strict: [{ path, parserPath: path }], exemptions: [] },
      readSource: createSourceReader({
        [path]: kind === "comment" ? `/* ${spoof} */ process.argv;` : `const help = \`${spoof}\`; process.argv;`,
      }),
    });
    expect(result.errors).toEqual([
      `Strict parser ${path} must import scripts/lib/cli-args.mjs and call parseStrictCliArgs().`,
    ]);
  });

  it("rejects a commented-out connection to an otherwise valid parser", () => {
    const path = "scripts/maintenance/operator.mjs";
    const parserPath = "scripts/lib/operator-parser.mjs";
    const result = evaluateCliArgsPolicy({
      discoveredPaths: [path],
      policy: { strict: [{ path, parserPath }], exemptions: [] },
      readSource: createSourceReader({
        [path]: '// import "../lib/operator-parser.mjs";\nprocess.argv;',
        [parserPath]: 'import { parseStrictCliArgs } from "./cli-args.mjs"; export const parse = (argv) => parseStrictCliArgs(argv);',
      }),
    });
    expect(result.errors).toEqual([
      `Strict CLI entrypoint ${path} does not import its declared parser ${parserPath}.`,
    ]);
  });

  it("rejects stale exact exemptions", () => {
    const path = "scripts/ci/removed-check.mjs";
    const result = evaluateCliArgsPolicy({
      discoveredPaths: [],
      policy: {
        strict: [],
        exemptions: [{ path, category: "read-only", reason: EXEMPTION_REASON }],
      },
      readSource: createSourceReader({}),
    });

    expect(result.errors).toContain(`Stale CLI policy entry no longer uses process.argv: ${path}`);
  });

  it("accepts an exact audited exemption", () => {
    const path = "scripts/ci/repository-check.mjs";
    const result = evaluateCliArgsPolicy({
      discoveredPaths: [path],
      policy: {
        strict: [],
        exemptions: [{ path, category: "read-only", reason: EXEMPTION_REASON }],
      },
      readSource: createSourceReader({}),
    });

    expect(result.errors).toEqual([]);
    expect(result.counts).toEqual({ discovered: 1, strict: 0, exempt: 1 });
  });

  it("rejects exemptions without an allowed category and audit reason", () => {
    const path = "scripts/ci/repository-check.mjs";
    const result = evaluateCliArgsPolicy({
      discoveredPaths: [path],
      policy: {
        strict: [],
        exemptions: [{ path, category: "operator", reason: "temporary" }],
      },
      readSource: createSourceReader({}),
    });

    expect(result.errors).toContain(`Invalid CLI exemption category for ${path}: operator`);
    expect(result.errors).toContain(`CLI exemption ${path} must have a specific audit reason.`);
  });

  it("rejects duplicate and conflicting policy declarations", () => {
    const path = "scripts/maintenance/operator.mjs";
    const parserSource = [
      'import { parseStrictCliArgs } from "../lib/cli-args.mjs";',
      "parseStrictCliArgs(process.argv.slice(2));",
    ].join("\n");
    const result = evaluateCliArgsPolicy({
      discoveredPaths: [path],
      policy: {
        strict: [
          { path, parserPath: path },
          { path, parserPath: path },
        ],
        exemptions: [{ path, category: "build", reason: EXEMPTION_REASON }],
      },
      readSource: createSourceReader({ [path]: parserSource }),
    });

    expect(result.errors).toContain(`Duplicate strict CLI policy entry: ${path}`);
    expect(result.errors).toContain(`CLI path cannot be both strict and exempt: ${path}`);
  });
});
