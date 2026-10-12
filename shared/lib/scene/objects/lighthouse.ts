/**
 * The kit lighthouse: the Pharos on its rock bastion (square base, octagonal middle, round lantern). One object for
 * every scene that draws it (the Cemetery, Harbor, the PSI lighthouse), so a restyle changes all of them.
 *
 * Class tokens (styled by `src/components/scene/scene-tokens.module.css`): `rock`, `rock-s` (bastion), `lh-t/-e/-s`
 * (base and gallery boxes), `lh-e/-m/-s` + `lh-t` cap (octagonal tower), `lh-win` (windows), `lh-c` (lantern deck),
 * `lh-glass` (lantern glass), and the hairline `e`.
 */
import type { SceneMark, SceneObjectGeometry } from "../marks";
import { worldPolygon } from "../marks";
import { project, round1, roundHalfWidth, type ScenePoint, type SceneProjection } from "../projection";
import { boxMarks, cylinder, octPrismMarks } from "../solids";

/** Lighthouse height to the finial (world units); the lantern centre sits at {@link LIGHTHOUSE_LANTERN_Z}. */
export const LIGHTHOUSE_TOP_Z = 6.05;
export const LIGHTHOUSE_LANTERN_Z = 5.3;

export interface LighthouseGeometry extends SceneObjectGeometry {
  /** Lantern centre: the beam origin (unrounded). */
  lantern: ScenePoint;
  /** Finial tip (unrounded). */
  top: ScenePoint;
}

/** The lighthouse standing at world (i, j); its bastion reaches 1.2 world units out and 0.55 below ground. */
export function lighthouseGeometry(p: SceneProjection, i: number, j: number): LighthouseGeometry {
  const m: SceneMark[] = [];
  m.push(...octPrismMarks(p, i, j, 1.18, -0.55, 0.16, ["rock", "rock", "rock-s"], "rock"));
  m.push(...boxMarks(p, i - 0.92, j - 0.92, 0.16, 1.84, 1.84, 0.28, "lh"));
  m.push(...boxMarks(p, i - 0.7, j - 0.7, 0.44, 1.4, 1.4, 2.35, "lh"));
  for (let row = 0; row < 3; row++) {
    const z = 0.9 + row * 0.62;
    m.push(worldPolygon(p, "lh-win", [[i + 0.705, j - 0.06, z], [i + 0.705, j + 0.06, z], [i + 0.705, j + 0.06, z + 0.26], [i + 0.705, j - 0.06, z + 0.26]]));
    m.push(worldPolygon(p, "lh-win", [[i - 0.06, j + 0.705, z + 0.15], [i + 0.06, j + 0.705, z + 0.15], [i + 0.06, j + 0.705, z + 0.41], [i - 0.06, j + 0.705, z + 0.41]]));
  }
  m.push(...boxMarks(p, i - 0.8, j - 0.8, 2.79, 1.6, 1.6, 0.12, "lh"));
  m.push(...octPrismMarks(p, i, j, 0.52, 2.91, 4.35));
  m.push(worldPolygon(p, "lh-win", [[i + 0.525, j - 0.05, 3.4], [i + 0.525, j + 0.05, 3.4], [i + 0.525, j + 0.05, 3.7], [i + 0.525, j - 0.05, 3.7]]));
  m.push(...octPrismMarks(p, i, j, 0.63, 4.35, 4.44));
  m.push(...cylinder(p, i, j, 0.36, 4.44, 5.05, "lh-c", null, "lh-t").marks);
  m.push(...cylinder(p, i, j, 0.46, 5.05, 5.11, "lh-c", null, "lh-t").marks);
  m.push(...cylinder(p, i, j, 0.29, 5.11, 5.52, "lh-glass", null, "lh-t").marks);
  const [dx, dy] = project(p, i, j, 5.52);
  const drx = 0.33 * roundHalfWidth(p);
  m.push({
    kind: "path",
    cls: "lh-t e",
    d: `M${round1(dx - drx)},${round1(dy)} A${round1(drx)},${round1(drx * 0.95)} 0 0 1 ${round1(dx + drx)},${round1(dy)} A${round1(drx)},${round1(drx / 2)} 0 0 1 ${round1(dx - drx)},${round1(dy)} Z`,
    transform: null,
  });
  const fin = project(p, i, j, LIGHTHOUSE_TOP_Z);
  m.push({ kind: "line", cls: "e", x1: round1(dx), y1: round1(dy - drx * 0.95), x2: round1(fin[0]), y2: round1(fin[1]) });
  return {
    marks: m,
    lantern: project(p, i, j, LIGHTHOUSE_LANTERN_Z),
    top: fin,
    pts: [project(p, i - 1.2, j, -0.55), project(p, i + 1.2, j, -0.55), project(p, i, j + 1.2, -0.55), project(p, i, j - 1.2, -0.55), fin],
  };
}
