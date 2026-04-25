import type { LighthouseCinematicModel } from "../cinematic-model";

export function AltPegProjectionLayer({
  model,
}: {
  model: LighthouseCinematicModel;
}) {
  const active = model.stage.mode === "atlas";
  return (
    <g className={active ? "lh-alt-peg-layer lh-alt-peg-layer--active" : "lh-alt-peg-layer"} aria-hidden="true">
      <path
        d="M 170 404 C 310 318 500 292 720 300 C 944 308 1128 330 1278 404"
        fill="none"
        stroke="oklch(0.8 0.09 88 / 0.22)"
        strokeWidth="1"
        strokeDasharray="6 10"
      />
      {model.altPeg.clusters.map((cluster) => (
        <g key={cluster.peg}>
          <circle cx={cluster.anchor.x} cy={cluster.anchor.y} r="14" fill={cluster.colorHex} opacity="0.1" />
          {cluster.coins.map((coin) => (
            <g key={coin.id} transform={`translate(${coin.x} ${coin.y})`}>
              <circle r={coin.sizePx / 2 + 6} fill={coin.colorHex} opacity="0.11" />
              <circle r={coin.sizePx / 2} fill="oklch(0.025 0.018 245 / 0.92)" stroke={coin.colorHex} strokeWidth="1.6" />
            </g>
          ))}
        </g>
      ))}
      {model.altPeg.skyCohorts.map((cohort) => (
        <g key={cohort.kind} className={`lh-peg-cohort lh-peg-cohort--${cohort.kind}`}>
          {cohort.coins.map((coin) => (
            <g key={coin.id} transform={`translate(${coin.x} ${coin.y})`}>
              <circle r={coin.sizePx / 2 + (cohort.kind === "sun" ? 12 : 7)} fill={coin.colorHex} opacity={cohort.kind === "sun" ? 0.18 : 0.11} />
              <circle r={coin.sizePx / 2} fill={coin.colorHex} opacity={cohort.kind === "moon" ? 0.56 : 0.78} />
            </g>
          ))}
        </g>
      ))}
    </g>
  );
}
