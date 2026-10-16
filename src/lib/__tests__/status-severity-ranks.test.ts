import { describe, expect, it } from "vitest";
import { worstSeverity } from "@/lib/status/workspace-mode";

describe("status severity ranks", () => {
  it("resolves the worst workspace severity, defaulting to healthy when empty", () => {
    expect(worstSeverity([])).toBe("healthy");
    expect(worstSeverity(["healthy", "watch"])).toBe("watch");
    expect(worstSeverity(["watch", "unknown"])).toBe("unknown");
    expect(worstSeverity(["unknown", "critical", "healthy"])).toBe("critical");
  });

});
