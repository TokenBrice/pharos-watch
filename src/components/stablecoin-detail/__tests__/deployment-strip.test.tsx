// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, within } from "@testing-library/react";
import { DeploymentRouteGroups, groupDeploymentRoutes, type DeploymentRoute } from "../deployment-strip";
import { BRIDGE_TIER_CELL_CLASSES, BRIDGE_TIER_UNKNOWN_CELL_CLASS, CONTROL_COMPONENT_ROLE_LABELS } from "@shared/lib/classification";

function route(key: string, overrides: Partial<DeploymentRoute> = {}): DeploymentRoute {
  return {
    key,
    label: `Chain ${key}`,
    tierKey: "external-lock-mint",
    tierLabel: "External lock & mint",
    ...overrides,
  };
}

const NATIVE = { tierKey: "single-chain-or-native", tierLabel: "Native" } as const;

function groupKeys(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-route-group]")).map((group) => group.getAttribute("data-route-group")!);
}

describe("DeploymentRouteGroups", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps +N more on the chips' own row: chips that would strand it move behind it", () => {
    // Every chip 50 px, the "+N more" 50 px (plus room for a digit), a 300 px list: four chips and the count fit one row.
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(50);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
    const routes = Array.from({ length: 12 }, (_, index) => route(`r${index}`));
    const { container } = render(
      <DeploymentRouteGroups ariaLabel="Routes" routes={routes} totals={{ "External lock & mint": 30 }} />,
    );
    const group = within(container).getByRole("list", { name: "External lock & mint routes" });
    expect(group.querySelectorAll("[data-route]")).toHaveLength(4);
    // The count still covers the whole inventory, and its title names the listed routes behind it.
    expect(group.querySelector("[data-more]")?.textContent).toBe("+26 more");
    expect(group.querySelector("[data-more]")?.getAttribute("title")).toMatch(/^Chain r4, Chain r5/);
  });

  it("groups routes by tier in published policy order, unrecognised then unresolved last", () => {
    const groups = groupDeploymentRoutes([
      route("unresolved", { unknown: true, tierKey: "opaque-or-unknown", tierLabel: "Unresolved route" }),
      route("lock"),
      route("mystery", { tierKey: "not-a-tier", tierLabel: "Mystery" }),
      route("eth", { ...NATIVE, home: true }),
      route("rollup", { tierKey: "canonical-rollup-bridge", tierLabel: "Canonical rollup bridge" }),
    ]);
    expect(groups.map((group) => group.key)).toEqual([
      "single-chain-or-native", "canonical-rollup-bridge", "external-lock-mint", "not-a-tier", "unresolved",
    ]);
    // Tier dots take the shared tier fill; an unestablished or unrecognised tier is hatched, never a hue.
    expect(groups[0]!.dotClass).toBe(BRIDGE_TIER_CELL_CLASSES["single-chain-or-native"]);
    expect(groups.at(-2)!.dotClass).toBe(BRIDGE_TIER_UNKNOWN_CELL_CLASS);
    expect(groups.at(-1)!.dotClass).toBe(BRIDGE_TIER_UNKNOWN_CELL_CLASS);
  });

  it("lists eight chain chips per group, then the rest of the inventory as +N more", () => {
    const routes = Array.from({ length: 12 }, (_, index) => route(`r${index}`));
    const { container } = render(
      <DeploymentRouteGroups ariaLabel="Routes" routes={routes} totals={{ "External lock & mint": 30 }} />,
    );
    const group = within(container).getByRole("list", { name: "External lock & mint routes" });
    expect(group.querySelectorAll("[data-route]")).toHaveLength(8);
    // The count and the overflow come from the inventory total, not the listed sample.
    expect(group.querySelector("[data-more]")?.textContent).toBe("+22 more");
    expect(container.querySelector("[data-group-count]")?.textContent).toBe("30 routes");
  });

  it("counts listed routes unless every group label has an inventory total", () => {
    const routes = [route("eth", { ...NATIVE }), route("a"), route("b")];
    const partial = render(<DeploymentRouteGroups ariaLabel="Routes" routes={routes} totals={{ Native: 1 }} />).container;
    expect(Array.from(partial.querySelectorAll("[data-group-count]")).map((node) => node.textContent)).toEqual([
      "1 route", "2 routes",
    ]);
    expect(partial.querySelector("[data-more]")).toBeNull();
  });

  it("tags a role every route in the group shares once, and marks each chip only in a mixed group", () => {
    const { container } = render(
      <DeploymentRouteGroups
        ariaLabel="Routes"
        routes={[
          route("eth", { ...NATIVE, home: true }),
          route("a", { role: "diagnostic" }),
          route("b", { role: "diagnostic" }),
          route("rollup-1", { tierKey: "canonical-rollup-bridge", tierLabel: "Canonical rollup bridge", role: "limiting" }),
          route("rollup-2", { tierKey: "canonical-rollup-bridge", tierLabel: "Canonical rollup bridge", role: "eligible" }),
        ]}
      />,
    );
    const [native, rollup, lock] = Array.from(container.querySelectorAll<HTMLElement>("[data-route-group]"));
    expect(native!.querySelector("[data-control-role]")).toBeNull();
    expect(native!.querySelector("[data-home-glyph]")).not.toBeNull();
    expect(native!.textContent).toContain("home chain");

    expect(lock!.querySelector("[data-control-role]")?.getAttribute("data-control-role")).toBe("diagnostic");
    expect(lock!.querySelector("[data-route='a']")?.className).not.toContain("border-dashed");

    expect(rollup!.querySelector("[data-control-role]")?.getAttribute("data-control-role")).toBe("limiting");
    expect(rollup!.querySelector("[data-route='rollup-1']")?.className).toContain("border-foreground/80");
    expect(rollup!.querySelector("[data-route='rollup-2']")?.className).not.toContain("border-foreground/80");
    // An eligible chip beside marked ones keeps a visible outline, solid where diagnostic is dashed, and names its role.
    expect(rollup!.querySelector("[data-route='rollup-2']")?.className).toContain("border-muted-foreground/60");
    expect(rollup!.querySelector("[data-route='rollup-2']")?.getAttribute("title")).toBe(CONTROL_COMPONENT_ROLE_LABELS.eligible);
  });

  it("states a limiting input no route carries once, above the groups", () => {
    const routes = [route("eth", { ...NATIVE, home: true }), route("sol", { ...NATIVE })];
    const banded = render(<DeploymentRouteGroups ariaLabel="Routes" routes={routes} bandLimiting="Bridge controls unverified" />).container;
    const line = banded.querySelector("[data-band-limiting]");
    expect(line?.textContent).toContain("Bridge controls unverified: applies to every route");
    expect(line?.querySelector("[data-control-role='limiting']")).not.toBeNull();

    const plain = render(<DeploymentRouteGroups ariaLabel="Routes" routes={routes} />).container;
    expect(plain.querySelector("[data-band-limiting]")).toBeNull();
  });

  it("says in words that routes are listed, not sized, and appends caller caveats", () => {
    const { container } = render(
      <DeploymentRouteGroups ariaLabel="Routes" routes={[route("a"), route("b")]} caveats={["the limiting route is not among those listed"]} />,
    );
    const caption = container.querySelector("[data-route-caption]")?.textContent ?? "";
    expect(caption).toContain("Supply per chain is not published");
    expect(caption).toContain("The limiting route is not among those listed.");
    expect(groupKeys(container)).toEqual(["external-lock-mint"]);
    expect(render(<DeploymentRouteGroups ariaLabel="Routes" routes={[]} />).container.innerHTML).toBe("");
  });
});
