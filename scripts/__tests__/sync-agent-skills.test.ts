import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { inspectAgentSkills, syncAgentSkills } from "../maintenance/sync-agent-skills.mjs";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeFixture({
  facade = true,
  companion = false,
  frontmatterName = "example-skill",
  allowlistedAgentMetadata = false,
  extraAgentMetadata = false,
}: {
  facade?: boolean;
  companion?: boolean;
  frontmatterName?: string;
  allowlistedAgentMetadata?: boolean;
  extraAgentMetadata?: boolean;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "pharos-agent-skills-"));
  temporaryRoots.push(root);

  const canonicalSkill = join(root, ".codex/skills/example-skill");
  mkdirSync(canonicalSkill, { recursive: true });
  writeFileSync(
    join(canonicalSkill, "SKILL.md"),
    `---\nname: ${frontmatterName}\ndescription: A fixture skill.\n---\n\n# Fixture\n`,
  );
  if (companion) writeFileSync(join(canonicalSkill, "reference.md"), "fixture companion\n");
  if (allowlistedAgentMetadata) {
    mkdirSync(join(canonicalSkill, "agents"), { recursive: true });
    writeFileSync(join(canonicalSkill, "agents/openai.yaml"), "display: fixture\n");
  }
  if (extraAgentMetadata) {
    mkdirSync(join(canonicalSkill, "agents"), { recursive: true });
    writeFileSync(join(canonicalSkill, "agents/extra.yaml"), "extra: fixture\n");
  }

  mkdirSync(join(root, ".agents"), { recursive: true });
  symlinkSync("../.codex/skills", join(root, ".agents/skills"));
  if (facade) {
    const facadeSkill = join(root, ".claude/skills/example-skill");
    mkdirSync(facadeSkill, { recursive: true });
    symlinkSync("../../../.codex/skills/example-skill/SKILL.md", join(facadeSkill, "SKILL.md"));
  }

  return { root, canonicalSkill, facadeSkill: join(root, ".claude/skills/example-skill") };
}

describe("sync-agent-skills", () => {
  it("checks skill-name parity and repairs missing facade directories and links", () => {
    const fixture = makeFixture({ facade: false, companion: true });

    const before = inspectAgentSkills(fixture.root);
    expect(before.violations).toEqual(expect.arrayContaining([
      expect.stringContaining("missing facade skill directory"),
    ]));

    const repaired = syncAgentSkills({ rootDir: fixture.root, write: true });
    expect(repaired.status).toBe(0);
    expect(repaired.changes).toEqual(expect.arrayContaining([
      expect.stringContaining("created directory .claude/skills/example-skill"),
      expect.stringContaining("created symlink .claude/skills/example-skill/reference.md"),
    ]));
    expect(lstatSync(join(fixture.facadeSkill, "reference.md")).isSymbolicLink()).toBe(true);
  });

  it("reports broken links and does not mutate check mode", () => {
    const fixture = makeFixture();
    const skillFile = join(fixture.facadeSkill, "SKILL.md");
    rmSync(skillFile);
    symlinkSync("../../../.codex/skills/example-skill/missing.md", skillFile);

    const result = syncAgentSkills({ rootDir: fixture.root });
    expect(result.status).toBe(1);
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.stringContaining("broken symlink"),
    ]));
    expect(readlinkSync(skillFile)).toBe("../../../.codex/skills/example-skill/missing.md");
  });

  it("reports missing companions while allowing agents display metadata", () => {
    const fixture = makeFixture({ companion: true, allowlistedAgentMetadata: true });

    const result = inspectAgentSkills(fixture.root);
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.stringContaining("missing facade symlink .claude/skills/example-skill/reference.md"),
    ]));
    expect(result.violations.some((violation) => violation.includes("agents/openai.yaml"))).toBe(false);
    expect(result.allowlisted).toContain(".codex/skills/example-skill/agents/openai.yaml");
  });

  it("validates nested canonical symlinks while preserving relative in-repo targets", () => {
    const fixture = makeFixture();
    const references = join(fixture.canonicalSkill, "references/nested");
    mkdirSync(references, { recursive: true });
    const link = join(references, "reference.md");
    symlinkSync("../../SKILL.md", link);
    expect(syncAgentSkills({ rootDir: fixture.root, write: true }).status).toBe(0);

    const outside = makeFixture();
    rmSync(link);
    symlinkSync(join(outside.canonicalSkill, "SKILL.md"), link);
    expect(inspectAgentSkills(fixture.root).violations).toContain(
      ".codex/skills/example-skill/references/nested/reference.md resolves outside repository",
    );

    rmSync(link);
    symlinkSync("missing.md", link);
    expect(inspectAgentSkills(fixture.root).violations).toContain(
      ".codex/skills/example-skill/references/nested/reference.md is a broken symlink",
    );
    expect(readlinkSync(link)).toBe("missing.md");
  });

  it("does not allowlist other files under agents", () => {
    const fixture = makeFixture({ extraAgentMetadata: true });

    const result = inspectAgentSkills(fixture.root);
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.stringContaining("missing facade symlink .claude/skills/example-skill/agents"),
    ]));
    expect(result.allowlisted).toEqual([]);
  });

  it("reports bad YAML frontmatter and a name mismatch", () => {
    const fixture = makeFixture({ frontmatterName: "wrong-name" });
    writeFileSync(
      join(fixture.canonicalSkill, "SKILL.md"),
      "---\nname: [broken\ndescription: missing parse\n---\n",
    );

    const result = inspectAgentSkills(fixture.root);
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.stringContaining("does not parse"),
    ]));

    writeFileSync(
      join(fixture.canonicalSkill, "SKILL.md"),
      "---\nname: wrong-name\ndescription: valid\n---\n",
    );
    const mismatch = inspectAgentSkills(fixture.root);
    expect(mismatch.violations).toEqual(expect.arrayContaining([
      expect.stringContaining("does not match directory example-skill"),
    ]));
  });

  it("rejects a physical Claude SKILL.md body", () => {
    const fixture = makeFixture();
    rmSync(join(fixture.facadeSkill, "SKILL.md"));
    writeFileSync(
      join(fixture.facadeSkill, "SKILL.md"),
      readFileSync(join(fixture.canonicalSkill, "SKILL.md")),
    );

    const result = inspectAgentSkills(fixture.root);
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.stringContaining("must be a symlink"),
      expect.stringContaining("duplicate physical body"),
    ]));
  });
});
