import { describe, expect, it } from "vitest";
import type { StatusCause } from "@shared/types";
import { STATUS_CAUSE_SEVERITY_RANK } from "@/lib/status/cause-severity";
import {
  buildWorkspaceModeUrl,
  parseWorkspaceMode,
  SEVERITY_RANK,
  worstSeverity,
  type WorkspaceSeverity,
} from "@/lib/status/workspace-mode";

/**
 * The two status severity vocabularies rank in opposite directions. Both
 * orderings are observable (issue lists put criticals first; workspace tabs
 * open on the worst mode), so pin them here rather than letting a future
 * "dedup" collapse them into one table.
 */
describe("status severity ranks", () => {
  it("ranks status causes worst-first so `<` selects the more severe cause", () => {
    const severities: StatusCause["severity"][] = ["critical", "warning", "info"];

    expect(severities.map((severity) => STATUS_CAUSE_SEVERITY_RANK[severity])).toEqual([0, 1, 2]);
    expect([...severities].reverse().sort((a, b) => STATUS_CAUSE_SEVERITY_RANK[a] - STATUS_CAUSE_SEVERITY_RANK[b]))
      .toEqual(["critical", "warning", "info"]);
    expect(STATUS_CAUSE_SEVERITY_RANK.critical).toBeLessThan(STATUS_CAUSE_SEVERITY_RANK.warning);
  });

  it("ranks workspace severity best-first so `>` selects the worse state", () => {
    const severities: WorkspaceSeverity[] = ["healthy", "watch", "unknown", "critical"];

    expect(severities.map((severity) => SEVERITY_RANK[severity])).toEqual([0, 1, 2, 3]);
    expect(SEVERITY_RANK.critical).toBeGreaterThan(SEVERITY_RANK.unknown);
    expect(SEVERITY_RANK.unknown).toBeGreaterThan(SEVERITY_RANK.watch);
  });

  it("resolves the worst workspace severity, defaulting to healthy when empty", () => {
    expect(worstSeverity([])).toBe("healthy");
    expect(worstSeverity(["healthy", "watch"])).toBe("watch");
    expect(worstSeverity(["watch", "unknown"])).toBe("unknown");
    expect(worstSeverity(["unknown", "critical", "healthy"])).toBe("critical");
  });

  it("parses known workspace modes and preserves unrelated URL state when updating", () => {
    const modes = [{ id: "first" }, { id: "second" }] as const;

    expect(parseWorkspaceMode(modes, "?view=second&scope=all")).toBe("second");
    expect(parseWorkspaceMode(modes, "?view=invalid")).toBeNull();
    expect(parseWorkspaceMode(modes, "?scope=all")).toBeNull();
    expect(
      buildWorkspaceModeUrl(
        { pathname: "/admin/example/", search: "?scope=all", hash: "#signal" } as Location,
        "first",
      ),
    ).toBe("/admin/example/?scope=all&view=first#signal");
  });
});
