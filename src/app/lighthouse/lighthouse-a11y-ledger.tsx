import type { LighthouseCinematicModel } from "./cinematic-model";
import { cn } from "@/lib/utils";

export function LighthouseA11yLedger({
  model,
  visible,
}: {
  model: LighthouseCinematicModel;
  visible: boolean;
}) {
  const selected = model.harbors.visible.find((harbor) => harbor.id === model.stage.selectedHarborId) ?? null;
  return (
    <section
      className={cn("lh-a11y-ledger", visible && "lh-a11y-ledger--visible")}
      aria-label="Lighthouse data ledger"
      data-testid="lighthouse-a11y-ledger"
    >
      <div className="lh-ledger-inner">
        <h2 className="lh-ledger-heading">Lighthouse data ledger</h2>
        <dl className="lh-ledger-grid">
          {model.fallbackRows.map((row) => (
            <div key={row.id} className="lh-ledger-row">
              <dt>{row.label}</dt>
              <dd>
                <strong>{row.value}</strong>
                <span>{row.detail}</span>
              </dd>
            </div>
          ))}
        </dl>
        <ol className="lh-ledger-harbors">
          {model.harbors.visible.map((harbor) => (
            <li key={harbor.id} data-selected={harbor.id === selected?.id || undefined}>
              <span>{harbor.name}</span>
              <span>{harbor.ariaLabel}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
