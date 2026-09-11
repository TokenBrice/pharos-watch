import { describe, expect, it } from "vitest";
import type { StatusCause } from "@shared/types";
import { normalizeStatusIssues } from "@/lib/status-dashboard-model";
import {
  buildWorkspaceModeUrl,
  parseWorkspaceMode,
  worstSeverity,
} from "@/lib/status/workspace-mode";

describe("status severity ranks", () => {
  it("normalizes status issues worst-first regardless of input order", () => {
    const causes: StatusCause[] = (["info", "critical", "warning"] as const).map((severity) => ({
      code: `test-${severity}`,
      layer: "data-quality",
      severity,
      message: severity,
    }));
    const issues = normalizeStatusIssues({ overall: causes, availability: [], dataQuality: [] });
    expect(issues.map((issue) => issue.severity)).toEqual(["critical", "warning", "info"]);
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
