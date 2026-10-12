/**
 * Scene kit paint servers. Gradients and the hatch pattern are rendered once per page in a 0×0 host SVG that is never
 * `display: none` (a hidden host breaks every `url(#…)` reference while a scene is hidden). Stops take their colour
 * from classes that read theme custom properties, so the host must sit inside the element that sets the scene's
 * tokens. IDs are `${idPrefix}-hatch` and `${idPrefix}-g-${id}` ({@link sceneDefId}); pick a prefix per scene.
 */
import type { ReactElement } from "react";
import kit from "./scene-tokens.module.css";

export interface SceneGradient {
  /** Becomes `${idPrefix}-g-${id}`. */
  id: string;
  /** `linear` runs left → right across the bounding box; `radial` from the centre out. */
  type: "linear" | "radial";
  /** `[offset, className]` pairs; the class sets `stop-color` / `stop-opacity`. */
  stops: readonly (readonly [string, string])[];
}

/**
 * The kit's own paint servers: `col`, the lighthouse lantern deck's column shading (kit `lh-c` fills from
 * `--scene-col`, `url(#scene-g-col)` by default). Render with `idPrefix="scene"`, or point `--scene-col` at your copy.
 */
export const SCENE_KIT_GRADIENTS: readonly SceneGradient[] = [
  { id: "col", type: "linear", stops: [["0", kit.colShade], [".45", kit.colMid], [".82", kit.colLit], ["1", kit.colMid]] },
];

/** The kit's paint-server host: `<SceneKitDefs />` gives `scene-hatch` and `scene-g-col`, plus any `gradients` of yours. */
export function SceneKitDefs({ gradients = [] }: { gradients?: readonly SceneGradient[] }): ReactElement {
  return <SceneDefs idPrefix="scene" className={kit.defs} hatchLineClassName={kit.hatchLine} gradients={[...SCENE_KIT_GRADIENTS, ...gradients]} />;
}

/** The id of a scene paint server: `sceneDefId("cem", "hatch")`, `sceneDefId("cem", "g-col")`. */
function sceneDefId(idPrefix: string, name: string): string {
  return `${idPrefix}-${name}`;
}

export function SceneDefs({
  idPrefix,
  className,
  hatchLineClassName,
  gradients,
}: {
  idPrefix: string;
  /** Host class: must size the SVG to 0×0 out of flow, never `display: none`. */
  className: string;
  /** When set, a 2.4-unit, 38° hairline hatch (`${idPrefix}-hatch`): the kit's "not recorded" fill. */
  hatchLineClassName?: string;
  gradients: readonly SceneGradient[];
}): ReactElement {
  return (
    <svg className={className} aria-hidden="true" focusable="false">
      <defs>
        {hatchLineClassName ? (
          <pattern id={sceneDefId(idPrefix, "hatch")} patternUnits="userSpaceOnUse" width="2.4" height="2.4" patternTransform="rotate(38)">
            <line className={hatchLineClassName} x1="0" y1="0" x2="0" y2="2.4" />
          </pattern>
        ) : null}
        {gradients.map((g) => {
          const stops = g.stops.map(([offset, cls]) => <stop key={offset} offset={offset} className={cls} />);
          const id = sceneDefId(idPrefix, `g-${g.id}`);
          return g.type === "linear" ? (
            <linearGradient key={g.id} id={id} x1="0" x2="1" y1="0" y2="0">
              {stops}
            </linearGradient>
          ) : (
            <radialGradient key={g.id} id={id}>
              {stops}
            </radialGradient>
          );
        })}
      </defs>
    </svg>
  );
}
