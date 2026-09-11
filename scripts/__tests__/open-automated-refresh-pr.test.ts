import { describe, expect, it, vi } from "vitest";
import { openAutomatedRefreshPr } from "../ci/open-automated-refresh-pr";

const options = {
  autoMerge: false,
  body: "Automated refresh body.",
  branch: "automated/example-refresh",
  paths: ["generated/example/"],
  title: "chore: refresh example",
};

describe("open automated refresh PR", () => {
  it("rejects a missing automation token instead of falling back to GITHUB_TOKEN", () => {
    const exec = vi.fn(() => "");

    expect(() =>
      openAutomatedRefreshPr(options, {
        env: { GITHUB_TOKEN: "default-actions-token", NODE_ENV: "test" },
        exec,
      }),
    ).toThrow(/AUTOMATION_GITHUB_TOKEN is required/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("force-pushes with lease and updates an existing open PR", () => {
    const exec = vi.fn((file: string, args: readonly string[]) => {
      if (file === "gh" && args[0] === "pr" && args[1] === "view") return "OPEN\n";
      return "";
    });
    const log = vi.fn();

    expect(openAutomatedRefreshPr({ ...options, autoMerge: true }, { automationToken: "pat", exec, log })).toBe("updated");
    expect(exec).toHaveBeenCalledWith(
      "git",
      ["push", "--force-with-lease", "-u", "origin", options.branch],
      expect.objectContaining({ env: expect.objectContaining({ GH_TOKEN: "pat" }) }),
    );
    expect(exec).not.toHaveBeenCalledWith("git", expect.arrayContaining(["--force"]), expect.anything());
    expect(exec).not.toHaveBeenCalledWith("gh", expect.arrayContaining(["create"]), expect.anything());
    expect(exec).not.toHaveBeenCalledWith("gh", expect.arrayContaining(["merge"]), expect.anything());
    expect(log).toHaveBeenCalledWith(expect.stringContaining("updated by force-push"));
  });

  it("creates and optionally queues auto-merge when no open PR exists", () => {
    const exec = vi.fn((file: string, args: readonly string[]) => {
      if (file === "gh" && args[0] === "pr" && args[1] === "view") {
        throw new Error("no pull request found");
      }
      return "";
    });

    expect(
      openAutomatedRefreshPr({ ...options, autoMerge: true }, { automationToken: "pat", exec }),
    ).toBe("created");
    expect(exec).toHaveBeenCalledWith(
      "gh",
      [
        "pr",
        "create",
        "--base",
        "main",
        "--head",
        options.branch,
        "--title",
        options.title,
        "--body",
        options.body,
      ],
      expect.objectContaining({ env: expect.objectContaining({ GH_TOKEN: "pat" }) }),
    );
    expect(exec).toHaveBeenCalledWith(
      "gh",
      ["pr", "merge", options.branch, "--squash", "--auto"],
      expect.objectContaining({ env: expect.objectContaining({ GH_TOKEN: "pat" }) }),
    );
  });

  it("uses the explicit automation credential without leaking conflicting GitHub tokens", () => {
    const exec = vi.fn((_file: string, _args: readonly string[], _options?: { env?: NodeJS.ProcessEnv }) => "");
    const env = { GH_TOKEN: "gh-default", GITHUB_TOKEN: "actions-default", AUTOMATION_GITHUB_TOKEN: "env-pat", NODE_ENV: "test" as const };
    expect(openAutomatedRefreshPr(options, { env, automationToken: "explicit-pat", exec })).toBe("created");
    const authenticated = exec.mock.calls.filter(([file, args]) => file === "gh" || args[0] === "push");
    expect(authenticated.map(([file, args]) => [file, ...args.slice(0, 2)])).toEqual([
      ["gh", "auth", "setup-git"], ["git", "push", "--force-with-lease"],
      ["gh", "pr", "view"], ["gh", "pr", "create"],
    ]);
    for (const [, , commandOptions] of authenticated) {
      expect(commandOptions?.env?.GH_TOKEN).toBe("explicit-pat");
      expect(commandOptions?.env).not.toHaveProperty("GITHUB_TOKEN");
    }
    expect(env.GITHUB_TOKEN).toBe("actions-default");
    expect(exec).not.toHaveBeenCalledWith("gh", expect.arrayContaining(["merge"]), expect.anything());
  });

  it.each(["commit", "push"])("stops publishing after a failed %s", (mutation) => {
    const failure = new Error(`${mutation} rejected`);
    const commands: string[] = [];
    const exec = vi.fn((file: string, args: readonly string[]) => {
      commands.push(`${file} ${args[0]}`);
      if (file === "git" && args[0] === mutation) throw failure;
      return "";
    });
    expect(() => openAutomatedRefreshPr({ ...options, autoMerge: true }, { automationToken: "pat", exec }))
      .toThrow(failure);
    expect(commands.at(-1)).toBe(`git ${mutation}`);
    expect(commands).not.toContain("gh pr");
    if (mutation === "commit") expect(commands).not.toContain("git push");
  });
});
