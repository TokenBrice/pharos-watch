import type { PharosVilleWorld } from "../systems/world-types";

export interface MapKeyProps {
  world: PharosVilleWorld;
  headingId?: string;
}

export function MapKey({ world, headingId = "pharosville-map-key-title" }: MapKeyProps) {
  return (
    <section aria-labelledby={headingId} data-testid="pharosville-map-key">
      <h2 id={headingId}>Map key</h2>
      <dl>
        {world.legends.map((item) => (
          <div key={item.id}>
            <dt>{item.label}</dt>
            <dd>{item.description}</dd>
          </div>
        ))}
      </dl>

      <h3>Visual cues</h3>
      <dl>
        {world.visualCues.map((cue) => (
          <div key={cue.id}>
            <dt>{cue.visual}</dt>
            <dd>
              {cue.questionAnswered} Source: {cue.sourceField}. DOM equivalent: {cue.domEquivalent}.
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
