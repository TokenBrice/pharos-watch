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
        env: { GITHUB_TOKEN: "default-actions-token" },
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

    expect(openAutomatedRefreshPr(options, { automationToken: "pat", exec, log })).toBe("updated");
    expect(exec).toHaveBeenCalledWith(
      "git",
      ["push", "--force-with-lease", "-u", "origin", options.branch],
      expect.objectContaining({ env: expect.objectContaining({ GH_TOKEN: "pat" }) }),
    );
    expect(exec).not.toHaveBeenCalledWith("git", expect.arrayContaining(["--force"]), expect.anything());
    expect(exec).not.toHaveBeenCalledWith("gh", expect.arrayContaining(["create"]), expect.anything());
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
});
