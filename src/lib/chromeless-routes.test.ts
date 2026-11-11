import { describe, expect, it } from "vitest";

import { getRouteCapabilities } from "@/lib/route-capabilities";

describe("chromeless capability", () => {
  it("matches the Telegram Mini App route family only", () => {
    expect(getRouteCapabilities("/pharoswatchbot/app").chromeless).toBe(true);
    expect(getRouteCapabilities("/pharoswatchbot/app/").chromeless).toBe(true);
    expect(getRouteCapabilities("/pharoswatchbot/app/settings").chromeless).toBe(true);
    expect(getRouteCapabilities("/pharoswatchbot").chromeless).toBe(false);
    expect(getRouteCapabilities("/pharoswatchbot/application").chromeless).toBe(false);
    expect(getRouteCapabilities("/").chromeless).toBe(false);
    expect(getRouteCapabilities(null).chromeless).toBe(false);
  });
});

describe("route capabilities", () => {
  it.each([
    ["/", "public", "home", false, false, true, false],
    ["/digest", "public", "route", false, true, false, true],
    ["/digest/2026-09-06/", "public", "route", false, true, false, true],
    ["/docs/example/", "public", "global", true, true, false, true],
    ["/docs-other", "public", "global", false, true, false, true],
    ["/api/reference/", "public", "global", false, true, false, false],
    ["/api/reference/child", "public", "global", false, true, false, true],
    ["/yield/", "public", "global", false, true, true, true],
    ["/yield//", "public", "global", false, true, false, true],
    ["/admin/actions/", "ops", "route", false, false, false, true],
    ["/pharoswatchbot/app/", "chromeless", "route", false, false, false, true],
    [null, "public", "global", false, true, false, true],
  ])("preserves independent capabilities for %s", (path, chrome, footer, editorial, regimeBar, dataAnchor, feedback) => {
    expect(getRouteCapabilities(path)).toMatchObject({ chrome, footer, editorial, regimeBar, dataAnchor, feedback });
  });
});
