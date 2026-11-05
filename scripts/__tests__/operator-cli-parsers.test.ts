import { join } from "node:path";
import fs from "node:fs";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { withTempRepo } from "./helpers/test-state";
import pkg from "../../package.json";

const launch = vi.hoisted(() => vi.fn());
vi.mock("playwright", () => ({ chromium: { launch } }));
import { parseFreezeStablecoinArgs as freeze } from "../maintenance/freeze-stablecoin";
import { parseD1InsightsArgs as d1 } from "../maintenance/capture-d1-insights.mjs";
import { parseSeoRenderBudgetArgs as seo, runSeoRenderBudget as runSeo } from "../maintenance/audit-seo-render-budget.mjs";
import { parseAgentLandArgs as land, runAgentLand as runLand } from "../maintenance/agent-land";
import { parseAgentWorktreeArgs as worktree, runAgentWorktree as runWorktree } from "../maintenance/agent-worktree";
import { run as wait } from "../maintenance/wait-pages-release-marker.ts";

const args = (line: string) => line ? line.split(" ") : [];
const landing = "--lane /lane --target /target --review /review.json --message-file /message";
const bootstrap = "--path lane --base HEAD";
const omissions = (line: string) => args(line).flatMap((_, i, argv) =>
  i % 2 ? [] : [[...argv.slice(0, i), ...argv.slice(i + 2)].join(" ")]);
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); syncBuiltinESMExports(); });

it.each([runLand, runWorktree].flatMap((run) => ["-h", "--help"].map((flag) => [run, flag] as const)))("runner help %s %s", (run, flag) => {
  const output = vi.fn();
  const effects = [vi.spyOn(cp, "spawnSync"), ...([
    "existsSync", "lstatSync", "readdirSync", "readFileSync", "readlinkSync", "realpathSync",
    "closeSync", "mkdirSync", "mkdtempSync", "openSync", "writeSync",
  ] as const).map((name) => vi.spyOn(fs, name))];
  for (const effect of effects) effect.mockImplementation(() => { throw Error("Unexpected I/O"); });
  syncBuiltinESMExports();
  expect(run([flag], { log: output, output })).toBeUndefined();
  expect(output).toHaveBeenCalledWith(expect.stringMatching(/^(Usage: )?agent:(land|worktree) /));
  for (const effect of effects) expect(effect).not.toHaveBeenCalled();
});

it.each(["land", "worktree"] as const)("agent command %s", (name) => {
  expect(pkg.scripts[`agent:${name}`]).toBe(`node --import tsx scripts/maintenance/agent-${name}.ts`);
});

it.each([
  [land, landing, { lane: "/lane", target: "/target", review: "/review.json", messageFile: "/message", apply: false, help: false }],
  [worktree, bootstrap, { path: "lane", base: "HEAD", apply: false, help: false }],
  [seo, "", { waitMs: 4000, json: false, help: false, apiFailureReplay: false }],
  [seo, "--routes=/,/api/ --wait-ms=0 --json", { routes: ["/", "/api/"], waitMs: 0, json: true }],
  [seo, "--url=https://x.test --api-failure-replay", { baseUrl: "https://x.test", apiFailureReplay: true }],
  ...[seo, land, worktree].flatMap((parse) => ["-h", "--help"].map((flag) => [parse, flag, { help: true }] as const)),
  [d1, "", { database: "stablecoin-db", config: "worker/wrangler.toml", limit: 50,
    periods: [], sortBy: [], output: null, dryRun: false }],
  [d1, "--period=7d --period 30d --sort-by=reads --sort-by time --dry-run",
    { periods: ["7d", "30d"], sortBy: ["reads", "time"], dryRun: true }],
] as const)("accepts %s %s", (parse, argv, want) => expect(parse(args(argv))).toMatchObject(want));

it.each([
  [seo, ["--unknown", "--url", "--wait-ms=invalid", "--wait-ms=-1", "--url=one --url=two", "extra", "--routes=,",
    "--api-failure-replay --api-failure-replay"]],
  [land, ["", "--lane", ...omissions(landing), ...["--unknown", "extra", "--lane /other"].map((extra) => `${landing} ${extra}`)]],
  [worktree, ["", "--path", ...omissions(bootstrap), ...["--unknown", "extra", "--path other"].map((extra) => `${bootstrap} ${extra}`)]],
  [d1, ["--unknown", "--database", "--limit=2x", "--limit=0", "--database=one --database=two", "extra",
    ..."database config limit period sort-by output".split(" ").flatMap((f) => [`--${f} --dry-run`, `--${f}=--dry-run`])]],
])("rejects %s usage", (parse, rows) => {
  for (const argv of rows) expect(() => parse(args(argv))).toThrow(expect.objectContaining({ exitCode: 2 }));
});

it("freeze targets", () => {
  expect(freeze(args("--dry-run usdc-circle"))).toEqual({ coinId: "usdc-circle", dryRun: true, help: false });
  for (const argv of ["", "one two"]) expect(() => freeze(args(argv))).toThrow("exactly one <coinId>");
  expect(() => freeze(args("--coin usdc-circle"))).toThrow("Unknown option");
});

it("SEO help avoids browser launch", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  launch.mockReset();
  await expect(runSeo(["--help"])).resolves.toBeUndefined();
  for (const text of ["--api-failure-replay", "Replay selected profile, Alt-Pegs and seed-pilot routes with API reads returning an injected 503."])
    expect(log).toHaveBeenCalledWith(expect.stringContaining(text));
  expect(launch).not.toHaveBeenCalled();
});

const executablePath = "/browser";
it.each([
  [undefined, undefined, {}], [" /browser ", undefined, { executablePath }],
  [undefined, " chrome-beta ", { channel: "chrome-beta" }], [" /browser ", " chrome-beta ", { executablePath }],
])("SEO launch %s %s", async (exe, channel, want) => {
  for (const [name, value] of Object.entries({ SEO_AUDIT_BROWSER_EXECUTABLE_PATH: exe, SEO_AUDIT_BROWSER_CHANNEL: channel,
    GITHUB_ACTIONS: "true", SMOKE_UI_BROWSER_CHANNEL: "chrome", SMOKE_UI_BROWSER_EXECUTABLE_PATH: "/other" })) vi.stubEnv(name, value);
  const failure = new Error();
  launch.mockReset().mockRejectedValue(failure);
  await expect(runSeo(args("--routes=/ --wait-ms=0"))).rejects.toBe(failure);
  expect(launch).toHaveBeenCalledExactlyOnceWith({ headless: true, ...want });
});

it("cache-busted marker retry", () => withTempRepo("release-marker", {
  "m.json": '{"commit":"target"}',
}, async (dir) => {
  const commits = ["old", "target"];
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    expect(new URL(String(input)).searchParams.get("expected")).toBe("target");
    return Response.json({ commit: commits.shift() });
  });
  await wait(["--url", "https://one.test/m.json", "--marker", join(dir, "m.json"), "--attempts", "2", "--delay-ms", "0"]);
  expect(fetch).toHaveBeenCalledTimes(2);
}));
