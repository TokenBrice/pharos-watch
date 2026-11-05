// @vitest-environment jsdom

import { fireEvent, cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "@/components/copy-button";
import { DataTableShell } from "@/components/data-table-shell";
import { EmptyStateSurface } from "@/components/empty-state-surface";
import { InteractiveTableRow } from "@/components/interactive-table-row";
import { createPortal } from "react-dom";
import { JsonLdScript } from "@/components/json-ld-script";
import { MobileSortPills } from "@/components/mobile-sort-pills";
import { QueryStateNotice } from "@/components/query-state-notice";
import { RowSparkline } from "@/components/row-sparkline";
import { SafetyGradeBadge } from "@/components/safety-grade-badge";
import { DeviationIcon } from "@/components/severity-icon";
import { ScoreBadgeWrapper } from "@/components/score-badge-wrapper";
import { safeJsonLd } from "@/lib/json-ld";
import type { SceneMark } from "@shared/lib/scene/marks";
import { PreferredSourcePrompt, PREFERRED_SOURCE_URL } from "../preferred-source-prompt";
import { AtlasWindow, SceneMarks } from "../scene/scene-marks";

const mockWriteText = vi.fn().mockResolvedValue(undefined);

Object.assign(navigator, {
  clipboard: { writeText: mockWriteText },
});

describe("CopyButton", () => {
  afterEach(() => {
    mockWriteText.mockClear();
  });

  it("copies text to clipboard on click", async () => {
    render(<CopyButton text="test-content" />);
    const button = screen.getByRole("button", { name: /copy/i });
    fireEvent.click(button);
    expect(mockWriteText).toHaveBeenCalledWith("test-content");
  });
});

describe("JsonLdScript", () => {
  it("preserves the existing safe serialization for HTML delimiters and line separators", () => {
    const json = safeJsonLd({ value: "<>&\u2028\u2029" });

    expect(json).toBe('{"value":"\\u003c\\u003e&\u2028\u2029"}');
    expect(renderToStaticMarkup(<JsonLdScript json={json} />)).toBe(
      `<script type="application/ld+json">${json}</script>`,
    );
  });
});

describe("DataTableShell", () => {
  it("keeps sortable header adornments outside the native sort button", () => {
    render(
      <DataTableShell
        columns={[{
          id: "score",
          label: "Score",
          sortKey: "score",
          headerAdornment: <button type="button">Help</button>,
        }]}
        sort={{
          sortKey: "score",
          sortDirection: "desc",
          toggleSort: () => {},
          getAriaSortValue: () => "descending",
        }}
      >
        <tr>
          <td>95</td>
        </tr>
      </DataTableShell>,
    );

    const sortButton = screen.getByRole("button", { name: "Sort by Score" });
    const helpButton = screen.getByRole("button", { name: "Help" });

    expect(sortButton.contains(helpButton)).toBe(false);
    expect(sortButton.closest("th")?.contains(helpButton)).toBe(true);
  });
});

describe("ScoreBadgeWrapper", () => {
  it("can render a non-interactive badge for link-wrapped cards", () => {
    render(
      <ScoreBadgeWrapper topic="safetyScore" interactive={false}>
        <span data-testid="badge-content">A</span>
      </ScoreBadgeWrapper>,
    );

    expect(screen.getByTestId("badge-content")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /explain safety score/i })).toBeNull();
  });
});

describe("DeviationIcon", () => {
  it("renders different SVG for healthy vs severe deviation", () => {
    const { container: healthy } = render(<DeviationIcon absBps={10} />);
    const healthySvgContent = healthy.querySelector("svg")?.innerHTML;
    cleanup();

    const { container: severe } = render(<DeviationIcon absBps={600} />);
    const severeSvgContent = severe.querySelector("svg")?.innerHTML;

    expect(healthySvgContent).not.toBe(severeSvgContent);
  });
});

describe("QueryStateNotice", () => {
  it("uses the classified unavailable tone while preserving its message API", () => {
    const { container } = render(<QueryStateNotice state="unavailable" label="Liquidity data" />);

    expect(screen.getByText("Liquidity data is temporarily unavailable. No status claim is being made.")).toBeTruthy();
    const className = container.firstElementChild?.getAttribute("class") ?? "";
    expect(className).toContain("bg-muted/40");
    expect(className).not.toMatch(/bg-amber-500|bg-state-warn/);
  });
});

describe("PreferredSourcePrompt", () => {
  it("renders an external link a crawler and a reader can both follow", () => {
    render(<PreferredSourcePrompt />);

    const link = screen.getByRole("link", { name: /add pharos watch in google/i });
    expect(link.getAttribute("href")).toBe(PREFERRED_SOURCE_URL);
    // Opens in a new tab because the deeplink cannot return the reader to
    // their scroll position the way Google's scripted flow does.
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel") ?? "").toContain("noopener");
  });
});

describe("scene marks", () => {
  it("maps class tokens through classOf and hands foreign marks to renderMark", () => {
    const marks: (SceneMark | { kind: "flag"; at: number })[] = [{ kind: "line", cls: "e", x1: 0, y1: 0, x2: 1, y2: 1 }, { kind: "flag", at: 3 }];
    const html = renderToStaticMarkup(<SceneMarks marks={marks} classOf={(cls) => `k-${cls}`} renderMark={(m: { kind: "flag"; at: number }, key) => <circle key={key} r={m.at} />} />);
    expect(html).toBe('<line class="k-e" x1="0" y1="0" x2="1" y2="1"></line><circle r="3"></circle>');
    expect(() => renderToStaticMarkup(<SceneMarks marks={marks} classOf={(cls) => cls} />)).toThrow(/no renderer for mark kind "flag"/);
  });

  it("windows one atlas cell", () => {
    const atlas = { href: "/a.webp?v=1", width: 100, height: 50, cellSize: 48, shift: -50, cells: {} };
    expect(renderToStaticMarkup(<AtlasWindow atlas={atlas} cell={[50, 0]} x={1} y={2} size={8} className="lg" />)).toBe(
      '<svg class="lg" x="1" y="2" width="8" height="8" viewBox="50 0 48 48"><image href="/a.webp?v=1" width="100" height="50"></image></svg>',
    );
  });
});

describe("EmptyStateSurface", () => {
  it("renders steps when provided", () => {
    const steps = [
      { title: "Step one", description: "Do the first thing." },
      { title: "Step two", description: "Do the second thing." },
    ];
    render(
      <EmptyStateSurface
        eyebrow="Guide"
        title="How it works"
        description="Follow these steps."
        steps={steps}
      />,
    );
    expect(screen.getByText("Step one")).toBeTruthy();
    expect(screen.getByText("Do the first thing.")).toBeTruthy();
    expect(screen.getByText("Step two")).toBeTruthy();
  });

  it("does not render steps list when no steps provided", () => {
    render(
      <EmptyStateSurface
        eyebrow="Guide"
        title="Empty"
        description="Nothing here."
      />,
    );
    expect(screen.queryByRole("list")).toBeNull();
  });
});

describe("MobileSortPills", () => {
  it("marks the active sort option and emits sort changes", () => {
    const onSort = vi.fn();

    render(
      <MobileSortPills
        options={[
          { key: "supply", label: "Supply" },
          { key: "peg", label: "Peg" },
        ]}
        sortKey="supply"
        sortDirection="desc"
        onSort={onSort}
        ariaLabel="Sort rows"
      />,
    );

    expect(screen.getByRole("group", { name: "Sort rows" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Supply/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("↓")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Peg" }));

    expect(onSort).toHaveBeenCalledWith("peg");
  });
});

describe("SafetyGradeBadge", () => {
  it("never turns a technical gap into a grade or a numeric score", () => {
    const { container } = render(<SafetyGradeBadge grade={null} score={null} />);
    expect(container.textContent).toContain("Pipeline gap");
    expect(container.textContent).not.toMatch(/\b(?:NR|F|0|100)\b/);
  });
  it("renders a labelled grade badge with optional score", () => {
    render(<SafetyGradeBadge grade="B+" score={78} />);

    const badge = screen.getByLabelText("Safety grade B+, score 78");
    expect(badge.textContent).toContain("B+");
    expect(badge.textContent).toContain("(78)");
  });
});

describe("RowSparkline", () => {
  it("renders the '—' fallback when fewer than 2 valid samples are present", () => {
    const data = Array<null>(30).fill(null);
    render(<RowSparkline data={data} ariaLabel="Test placeholder" />);
    expect(screen.getByTestId("row-sparkline-empty").textContent).toBe("—");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("draws a reference line when referenceValue is provided", () => {
    const data = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 50 : -50));
    const { container } = render(
      <RowSparkline data={data} signed referenceValue={0} ariaLabel="Signed" />,
    );
    expect(container.querySelector("line")).not.toBeNull();
  });

  it("breaks the path across nulls into multiple segments", () => {
    // 30 points: first 10 valid, then 10 nulls (gap), then 10 valid → 2 segments
    const data: Array<number | null> = [
      ...Array.from({ length: 10 }, (_, i) => i),
      ...Array<null>(10).fill(null),
      ...Array.from({ length: 10 }, (_, i) => i + 20),
    ];
    const { container } = render(<RowSparkline data={data} ariaLabel="Gapped" />);
    // Two segments → at least two stroke paths (each segment also has a fill).
    const paths = container.querySelectorAll("path");
    expect(paths.length).toBeGreaterThanOrEqual(4); // 2 segments × (area + line)
  });

  it("renders accessible title via aria-labelledby", () => {
    const data = Array.from({ length: 10 }, (_, i) => i);
    render(<RowSparkline data={data} ariaLabel="Test sparkline" />);
    const svg = screen.getByRole("img");
    expect(svg.getAttribute("aria-labelledby")).toBeTruthy();
    expect(svg.querySelector("title")?.textContent).toBe("Test sparkline");
  });
});

describe("InteractiveTableRow", () => {
  it("keeps native rows and guarded pointer activation with bubbling hover/focus", () => {
    const activate = vi.fn(), hover = vi.fn();
    render(<div tabIndex={-1}><table><tbody>
      <InteractiveTableRow id="coin-row" onActivate={activate} onHover={hover}>
        <td>Coin<a href="#coin">Open</a><button><svg><path /></svg></button>
          <span onClick={(event) => event.preventDefault()}>Prevented</span>
          {createPortal(<p>Dialog<button>Close</button></p>, document.body)}
        </td>
      </InteractiveTableRow>
    </tbody></table></div>);
    const row = screen.getByRole("row");
    expect(row.id).toBe("coin-row");
    expect(row.getAttribute("tabindex")).toBeNull();
    fireEvent.click(row);
    expect(activate).toHaveBeenCalledTimes(1);
    activate.mockClear();
    for (const options of [{ button: 1 }, { button: 2 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) fireEvent.click(row, options);
    for (const target of row.querySelectorAll("td > *, svg, path")) expect(fireEvent.click(target)).toBe(target.textContent !== "Prevented");
    for (const key of ["Enter", " ", "ArrowDown"]) expect(fireEvent.keyDown(row, { key })).toBe(true);
    for (const target of [screen.getByText("Dialog"), screen.getByRole("button", { name: "Close" })]) fireEvent.click(target);
    fireEvent.focus(screen.getByRole("link", { name: "Open" }));
    expect(hover).toHaveBeenCalledTimes(1);
    fireEvent.mouseEnter(row);
    expect(hover).toHaveBeenCalledTimes(2);
    expect(activate).not.toHaveBeenCalled();
  });
});
