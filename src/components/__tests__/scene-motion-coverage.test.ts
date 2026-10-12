/**
 * Scene kit motion rule: every transition or animation in a scene stylesheet takes its duration from the kit's
 * `--scene-dur-*` tokens, which are 0 ms under reduced motion (`scene-tokens.module.css`). A literal non-zero
 * duration outside a reduced-motion block would keep moving for a reader who asked for no motion.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import postcss, { AtRule, Rule, type Container } from "postcss";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const SCENE_DIR = "src/components/scene";
const CEMETERY_DIR = "src/components/cemetery";
const HARBOR_DIR = "src/components/harbor";
const BEACON_DIR = "src/components/psi-beacon";

const sheets = [
  ...readdirSync(join(ROOT, SCENE_DIR)).filter((f) => f.endsWith(".module.css")).map((f) => `${SCENE_DIR}/${f}`),
  ...readdirSync(join(ROOT, CEMETERY_DIR)).filter((f) => /^plot-map.*\.module\.css$/.test(f)).map((f) => `${CEMETERY_DIR}/${f}`),
  ...readdirSync(join(ROOT, HARBOR_DIR)).filter((f) => f.endsWith(".module.css")).map((f) => `${HARBOR_DIR}/${f}`),
  ...readdirSync(join(ROOT, BEACON_DIR)).filter((f) => f.endsWith(".module.css")).map((f) => `${BEACON_DIR}/${f}`),
];

const MOTION_PROPS = new Set(["transition", "transition-duration", "transition-delay", "animation", "animation-duration", "animation-delay"]);
/** A time literal (`120ms`, `.3s`); zero (`0s`, `0ms`) is allowed. */
const TIME = /(?<![\w-])(\d*\.?\d+)(m?s)\b/g;

function inReducedMotionBlock(node: Container | undefined): boolean {
  for (let n = node; n; n = n.parent as Container | undefined) {
    if (n instanceof AtRule && n.name === "media" && /prefers-reduced-motion:\s*reduce/.test(n.params)) return true;
    if (n instanceof Rule && n.selector.includes('data-motion="reduced"')) return true;
  }
  return false;
}

describe("scene motion coverage", () => {
  it("finds the kit tokens sheet and the cemetery's, Harbor's and the PSI beacon's scene sheets", () => {
    expect(sheets.some((path) => path.startsWith(`${HARBOR_DIR}/`))).toBe(true);
    expect(sheets).toContain(`${BEACON_DIR}/psi-beacon.module.css`);
    expect(sheets).toContain(`${SCENE_DIR}/scene-tokens.module.css`);
    expect(sheets).toContain(`${CEMETERY_DIR}/plot-map.module.css`);
    expect(sheets).toContain(`${CEMETERY_DIR}/plot-map-mobile.module.css`);
  });

  it("uses only --scene-dur-* tokens (or 0) for transition and animation timing", () => {
    const offenders: string[] = [];
    let tokenUses = 0;
    for (const path of sheets) {
      postcss.parse(readFileSync(join(ROOT, path), "utf8")).walkDecls((decl) => {
        if (!MOTION_PROPS.has(decl.prop)) return;
        if (decl.value.includes("var(--scene-dur-")) tokenUses++;
        if (inReducedMotionBlock(decl.parent as Container | undefined)) return;
        for (const [, n, unit] of decl.value.matchAll(TIME)) {
          if (Number(n) !== 0) offenders.push(`${path}: ${(decl.parent as Rule).selector} { ${decl.prop}: ${decl.value} } (${n}${unit})`);
        }
      });
    }
    expect(offenders).toEqual([]);
    // the hover tag, the flower bloom and the phone sheet (two states) all read the tokens
    expect(tokenUses).toBeGreaterThanOrEqual(4);
  });

  it("zeroes every duration token under both reduced-motion switches", () => {
    const css = readFileSync(join(ROOT, SCENE_DIR, "scene-tokens.module.css"), "utf8");
    const declared = new Set<string>();
    const zeroed = { attribute: new Set<string>(), media: new Set<string>() };
    postcss.parse(css).walkDecls(/^--scene-dur-/, (decl) => {
      const rule = decl.parent as Rule;
      if (rule.selector.includes('data-motion="reduced"')) {
        if (decl.value === "0ms") zeroed.attribute.add(decl.prop);
      } else if (inReducedMotionBlock(rule)) {
        if (decl.value === "0ms" && rule.selector.includes(':not([data-motion="full"])')) zeroed.media.add(decl.prop);
      } else declared.add(decl.prop);
    });
    expect(declared.size).toBeGreaterThan(0);
    expect([...zeroed.attribute].sort()).toEqual([...declared].sort());
    expect([...zeroed.media].sort()).toEqual([...declared].sort());
  });
});
