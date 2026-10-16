import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SceneMark } from "@shared/lib/scene/marks";
import { AtlasWindow, SceneMarks } from "../scene/scene-marks";

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

