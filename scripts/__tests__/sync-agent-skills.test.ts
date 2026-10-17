import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectAgentSkills, syncAgentSkills } from "../maintenance/sync-agent-skills.mjs";

let rootDir: string;

function skillSource(name: string) {
  return `---\nname: ${name}\ndescription: A project-specific test workflow.\n---\n\n# Workflow\n`;
}

function createSkill(name: string) {
  const skillPath = join(rootDir, ".codex/skills", name);
  mkdirSync(join(skillPath, "references"), { recursive: true });
  mkdirSync(join(skillPath, "agents"));
  writeFileSync(join(skillPath, "SKILL.md"), skillSource(name));
  writeFileSync(join(skillPath, "references/context.md"), "Project context.\n");
  writeFileSync(join(skillPath, "agents/openai.yaml"), "display_name: Test workflow\n");
  return skillPath;
}

function createFacade(name: string) {
  const facadePath = join(rootDir, ".claude/skills", name);
  mkdirSync(facadePath, { recursive: true });
  for (const entry of ["SKILL.md", "references"]) {
    symlinkSync(`../../../.codex/skills/${name}/${entry}`, join(facadePath, entry));
  }
  return facadePath;
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "pharos-agent-skills-"));
  mkdirSync(join(rootDir, ".codex/skills"), { recursive: true });
  mkdirSync(join(rootDir, ".claude/skills"), { recursive: true });
  mkdirSync(join(rootDir, ".agents"));
  symlinkSync("../.codex/skills", join(rootDir, ".agents/skills"));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe("sync-agent-skills", () => {
  it("accepts symlink-only facades and allowlists only Codex display metadata", () => {
    createSkill("example");
    createFacade("example");

    expect(inspectAgentSkills(rootDir)).toEqual({
      violations: [],
      allowlisted: [".codex/skills/example/agents/openai.yaml"],
      canonicalSkills: ["example"],
      facadeSkills: ["example"],
    });
  });

  it("creates missing facades only in write mode and converges without further changes", () => {
    createSkill("example");

    expect(syncAgentSkills({ rootDir })).toMatchObject({ status: 1, changes: [] });
    expect(() => lstatSync(join(rootDir, ".claude/skills/example"))).toThrow();
    expect(syncAgentSkills({ rootDir, write: true }).status).toBe(0);
    expect(readlinkSync(join(rootDir, ".claude/skills/example/SKILL.md")))
      .toBe("../../../.codex/skills/example/SKILL.md");
    expect(syncAgentSkills({ rootDir, write: true })).toMatchObject({ status: 0, changes: [] });
  });

  it.each(["identical", "different"])("rejects a %s physical skill body without replacing it", (body) => {
    const canonicalPath = createSkill("example");
    const facadePath = createFacade("example");
    const bodyPath = join(facadePath, "SKILL.md");
    const source = body === "identical" ? readFileSync(join(canonicalPath, "SKILL.md"), "utf8") : "Different body.\n";
    unlinkSync(bodyPath);
    writeFileSync(bodyPath, source);

    const result = syncAgentSkills({ rootDir, write: true });

    expect(result.status).toBe(1);
    expect(result.violations).toContain(".claude/skills/example/SKILL.md is a physical SKILL.md; it must be a symlink");
    expect(readFileSync(bodyPath, "utf8")).toBe(source);
  });

  it("rejects physical companion directories without replacing them", () => {
    createSkill("example");
    const facadePath = createFacade("example");
    unlinkSync(join(facadePath, "references"));
    mkdirSync(join(facadePath, "references"));
    writeFileSync(join(facadePath, "references/context.md"), "Physical context.\n");

    const result = syncAgentSkills({ rootDir, write: true });

    expect(result.status).toBe(1);
    expect(result.violations).toContain(".claude/skills/example/references must be a symlink");
    expect(readFileSync(join(facadePath, "references/context.md"), "utf8")).toBe("Physical context.\n");
  });

  it("prunes a deleted skill's managed facade only in write mode", () => {
    const canonicalPath = createSkill("removed");
    const facadePath = createFacade("removed");
    rmSync(canonicalPath, { recursive: true });

    expect(syncAgentSkills({ rootDir })).toMatchObject({
      status: 1,
      changes: [],
      violations: ["unexpected facade skill directory .claude/skills/removed"],
    });
    expect(lstatSync(join(facadePath, "references")).isSymbolicLink()).toBe(true);

    const result = syncAgentSkills({ rootDir, write: true });

    expect(result).toMatchObject({ status: 0, violations: [], canonicalSkills: [], facadeSkills: [] });
    expect(result.changes).toEqual([
      "removed symlink .claude/skills/removed/references",
      "removed symlink .claude/skills/removed/SKILL.md",
      "removed directory .claude/skills/removed",
    ]);
    expect(() => lstatSync(facadePath)).toThrow();
    expect(syncAgentSkills({ rootDir, write: true })).toMatchObject({ status: 0, changes: [] });
  });

  it("prunes an old managed facade and creates its replacement after a canonical rename", () => {
    const oldPath = createSkill("old-name");
    const oldFacadePath = createFacade("old-name");
    const newPath = join(rootDir, ".codex/skills/new-name");
    renameSync(oldPath, newPath);
    writeFileSync(join(newPath, "SKILL.md"), skillSource("new-name"));
    createSkill("unchanged");
    const unchangedFacadePath = createFacade("unchanged");

    expect(syncAgentSkills({ rootDir, write: true })).toMatchObject({
      status: 0,
      violations: [],
      canonicalSkills: ["new-name", "unchanged"],
      facadeSkills: ["new-name", "unchanged"],
    });
    expect(() => lstatSync(oldFacadePath)).toThrow();
    expect(readlinkSync(join(rootDir, ".claude/skills/new-name/SKILL.md")))
      .toBe("../../../.codex/skills/new-name/SKILL.md");
    expect(readlinkSync(join(unchangedFacadePath, "references")))
      .toBe("../../../.codex/skills/unchanged/references");
  });

  it.each(["physical file", "physical directory", "unmanaged symlink", "empty directory"])(
    "preserves an orphan wrapper containing an %s and all of its entries",
    (kind) => {
      const canonicalPath = createSkill("removed");
      const facadePath = createFacade("removed");
      rmSync(canonicalPath, { recursive: true });
      if (kind === "physical file") writeFileSync(join(facadePath, "local.md"), "Keep me.\n");
      if (kind === "physical directory") mkdirSync(join(facadePath, "local"));
      if (kind === "unmanaged symlink") {
        symlinkSync("../../../.codex/skills/another/local.md", join(facadePath, "local.md"));
      }
      if (kind === "empty directory") {
        unlinkSync(join(facadePath, "SKILL.md"));
        unlinkSync(join(facadePath, "references"));
      }

      const result = syncAgentSkills({ rootDir, write: true });

      expect(result).toMatchObject({ status: 1, changes: [] });
      expect(result.violations).toContain("unexpected facade skill directory .claude/skills/removed");
      expect(lstatSync(facadePath).isDirectory()).toBe(true);
      if (kind !== "empty directory") {
        expect(readlinkSync(join(facadePath, "SKILL.md")))
          .toBe("../../../.codex/skills/removed/SKILL.md");
        expect(readlinkSync(join(facadePath, "references")))
          .toBe("../../../.codex/skills/removed/references");
        expect(lstatSync(join(facadePath, kind === "physical directory" ? "local" : "local.md")))
          .toBeDefined();
      }
    },
  );

  it("does not prune anything when the canonical root is missing", () => {
    createSkill("example");
    const facadePath = createFacade("example");
    rmSync(join(rootDir, ".codex/skills"), { recursive: true });

    expect(syncAgentSkills({ rootDir, write: true })).toMatchObject({ status: 1, changes: [] });
    expect(readlinkSync(join(facadePath, "SKILL.md")))
      .toBe("../../../.codex/skills/example/SKILL.md");
  });
});
