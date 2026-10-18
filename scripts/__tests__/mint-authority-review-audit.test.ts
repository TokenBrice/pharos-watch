import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { buildMintAuthorityReviewAudit, renderMintAuthorityReviewAuditMarkdown } from "../lib/mint-authority-review-audit";
import { parseArgs, runCli, uniqueMintAuthoritySourceUrls } from "../maintenance/generate-mint-authority-review-audit";

const generatedAt = "2026-10-17T00:00:00.000Z";
const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("mint-authority-review-audit", () => {
  it("does not leave an explicit upgrade authority without a profile-level record", () => {
    const missing = TRACKED_STABLECOINS.filter(
      (meta) =>
        meta.mintAuthority?.upgradeability == null &&
        meta.mintAuthority?.controls?.some((control) => control.directMintAbility === "upgrade-only"),
    ).map((meta) => meta.id);

    expect(missing).toEqual([]);
  });
});

describe("Mint Authority review audit CLI", () => {
  it("defaults to Markdown and retains the audit-specific options", () => {
    expect(parseArgs([], new Date(generatedAt))).toEqual({
      generatedAt,
      format: "markdown",
      reportPath: null,
      live: false,
      liveLimit: 50,
    });
    expect(parseArgs(["--json", "--report", "audit.json", "--generated-at", generatedAt, "--live", "--live-limit", "2"]))
      .toEqual({ generatedAt, format: "json", reportPath: "audit.json", live: true, liveLimit: 2 });
    expect(parseArgs(["--json", "--markdown"]).format).toBe("markdown");
    expect(parseArgs(["--live-limit=2", "--json", "--generated-at=" + generatedAt]))
      .toMatchObject({ liveLimit: 2, generatedAt, format: "json" });
  });

  it.each([
    { argv: ["--format", "json"] },
    { argv: ["--out", "audit.json"] },
    { argv: ["--unknown"] },
    { argv: ["--report"] },
    { argv: ["--generated-at"] },
    { argv: ["--live-limit"] },
    { argv: ["--live-limit", "0"] },
    { argv: ["--live-limit", "1.5"] },
    { argv: ["--live-limit", "invalid"] },
    { argv: ["--report=one", "--report=two"] },
    { argv: ["--json", "--json"] },
    { argv: ["extra"] },
  ])("rejects invalid usage: $argv", ({ argv }) => {
    expect(() => parseArgs(argv)).toThrow(expect.objectContaining({ exitCode: 2 }));
  });

  it.each(["--help", "-h"])("documents the shared flags for %s", (flag) => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("help exit"); });

    expect(() => parseArgs([flag])).toThrow("help exit");
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("--json"));
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("--report <path>"));
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it.each(["markdown", "json"] as const)("preserves %s output without live network reads", async (format) => {
    const stdout = { write: vi.fn((_chunk: string) => true) };
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    const audit = buildMintAuthorityReviewAudit({ coins: TRACKED_STABLECOINS, generatedAt });

    await expect(runCli([`--${format}`, "--generated-at", generatedAt], stdout)).resolves.toBe(0);

    const output = stdout.write.mock.calls[0][0];
    expect(output).toBe(format === "json"
      ? `${JSON.stringify(audit, null, 2)}\n`
      : `${renderMintAuthorityReviewAuditMarkdown(audit)}\n`);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["markdown", "json"] as const)("writes a %s report with the existing acknowledgement", async (format) => {
    const root = mkdtempSync(join(tmpdir(), "pharos-mint-audit-"));
    tempDirs.push(root);
    const target = join(root, "reports", `audit.${format === "json" ? "json" : "md"}`);
    const stdout = { write: vi.fn((_chunk: string) => true) };
    const audit = buildMintAuthorityReviewAudit({ coins: TRACKED_STABLECOINS, generatedAt });

    await expect(runCli([`--${format}`, "--report", target, "--generated-at", generatedAt], stdout)).resolves.toBe(0);

    expect(readFileSync(target, "utf8")).toBe(format === "json"
      ? `${JSON.stringify(audit, null, 2)}\n`
      : `${renderMintAuthorityReviewAuditMarkdown(audit)}\n`);
    expect(stdout.write).toHaveBeenCalledExactlyOnceWith(`Wrote Mint Authority review audit to ${target}\n`);
  });

  it("keeps live probes bounded and advisory for Markdown", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchImpl);
    const stdout = { write: vi.fn((_chunk: string) => true) };

    await expect(runCli(["--live", "--live-limit", "1", "--generated-at", generatedAt], stdout)).resolves.toBe(0);

    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(uniqueMintAuthoritySourceUrls()[0], {
      method: "HEAD",
      redirect: "follow",
      signal: expect.any(AbortSignal),
    });
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining("## Live Source Probe"));
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining("Checked 1 source URL(s)"));
    expect(stdout.write).toHaveBeenCalledWith(expect.stringContaining(`- 500 ${uniqueMintAuthoritySourceUrls()[0]}`));
  });

  it("does not probe sources or change the JSON schema with --live", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    const stdout = { write: vi.fn((_chunk: string) => true) };

    await expect(runCli(["--json", "--live", "--generated-at", generatedAt], stdout)).resolves.toBe(0);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.write.mock.calls[0][0])).toEqual(
      buildMintAuthorityReviewAudit({ coins: TRACKED_STABLECOINS, generatedAt }),
    );
  });
});
