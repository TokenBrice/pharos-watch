import type { Lighthouse2Model } from "./nautical-model";

export function Lighthouse2A11yLedger({ model }: { model: Lighthouse2Model }) {
  return (
    <section className="sr-only" aria-label="Lighthouse 2 data ledger" data-testid="lighthouse-2-a11y-ledger">
      <h2>Lighthouse 2 data ledger</h2>
      <dl>
        {model.ledgerRows.map((row) => (
          <div key={row.id}>
            <dt>{row.label}</dt>
            <dd>
              <strong>{row.value}</strong>
              <span>{row.detail}</span>
            </dd>
          </div>
        ))}
      </dl>
      <h3>Chain vessels</h3>
      <ol>
        {model.chains.vessels.map((vessel) => (
          <li key={vessel.id}>{vessel.ariaLabel}</li>
        ))}
      </ol>
      <h3>DEWS buoys</h3>
      <ol>
        {model.dews.buoys.map((buoy) => (
          <li key={buoy.id}>{buoy.ariaLabel}</li>
        ))}
      </ol>
      <h3>Alt-peg islands</h3>
      <ol>
        {model.altPegs.islands.map((island) => (
          <li key={island.id}>{island.ariaLabel}</li>
        ))}
      </ol>
    </section>
  );
}
