import type { LighthouseCinematicModel } from "./cinematic-model";

export function LighthouseA11yLedger({
  model,
}: {
  model: LighthouseCinematicModel;
}) {
  return (
    <section
      className="sr-only"
      aria-label="Lighthouse data ledger"
      data-testid="lighthouse-a11y-ledger"
    >
      <div>
        <h2>Lighthouse data ledger</h2>
        <dl>
          {model.fallbackRows.map((row) => (
            <div key={row.id}>
              <dt>{row.label}</dt>
              <dd>
                <strong>{row.value}</strong>
                <span>{row.detail}</span>
              </dd>
            </div>
          ))}
        </dl>
        <ol>
          {model.harbors.visible.map((harbor) => (
            <li key={harbor.id}>
              <span>{harbor.name}</span>
              <span>{harbor.ariaLabel}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
