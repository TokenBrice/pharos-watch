import type { SceneData } from "./systems/scene-data";

export function LighthouseA11yLedger({ scene }: { scene: SceneData }) {
  return (
    <section className="sr-only" aria-label="Lighthouse data ledger" data-testid="lighthouse-a11y-ledger">
      <h2>Lighthouse data ledger</h2>
      <dl>
        <div>
          <dt>Lighthouse beam</dt>
          <dd>
            <strong>{scene.beam.band}</strong>
            <span> PSI score {scene.beam.score}, sweep {scene.beam.sweepSeconds.toFixed(1)} s</span>
          </dd>
        </div>
        <div>
          <dt>Sea state</dt>
          <dd>
            <strong>{scene.sea.highestBand}</strong>
            <span> wave amplitude {scene.sea.amplitudePx.toFixed(1)} px</span>
          </dd>
        </div>
      </dl>

      <h3>Harbors</h3>
      <ol>
        {scene.harbors.map((h) => (
          <li key={h.id}>
            <strong>{h.name}</strong>
            <span> {h.stablecoinCount} stablecoins, ${formatUsd(h.totalUsd)} total, resilience tier {h.resilienceTier}</span>
            <ol>
              {h.boats.map((b) => (
                <li key={b.coinId}>{b.symbol} ({b.style}, {b.hullSize}, supply ${formatUsd(b.supplyUsd)})</li>
              ))}
            </ol>
          </li>
        ))}
      </ol>

      <h3>Alt-peg cohorts</h3>
      <ol>
        {scene.horizon.cohorts.map((c) => (
          <li key={c.id}>{c.label} ({c.coinCount} coins)</li>
        ))}
      </ol>
    </section>
  );
}

function formatUsd(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  return `${n.toFixed(0)}`;
}
