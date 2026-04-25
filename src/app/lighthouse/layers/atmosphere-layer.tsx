import type { LighthouseCinematicModel } from "../cinematic-model";

export function AtmosphereLayer({
  model,
}: {
  model: LighthouseCinematicModel;
}) {
  const heavyFog = model.harbors.fogBand === "fog";
  const { width, height } = model.stage.viewBox;
  return (
    <g aria-hidden="true" className="lh-atmosphere-layer">
      <rect x="0" y="0" width={width} height={height} fill="url(#lh-night-sky)" />
      <path
        d={`M 0 ${model.stage.waterlineY - 152} C 240 ${model.stage.waterlineY - 184} 420 ${model.stage.waterlineY - 132} 620 ${model.stage.waterlineY - 166} C 840 ${model.stage.waterlineY - 206} 1080 ${model.stage.waterlineY - 130} 1290 ${model.stage.waterlineY - 176} C 1510 ${model.stage.waterlineY - 218} 1710 ${model.stage.waterlineY - 156} ${width} ${model.stage.waterlineY - 206} L ${width} ${model.stage.waterlineY + 54} L 0 ${model.stage.waterlineY + 54} Z`}
        fill="oklch(0.84 0.026 245 / 0.065)"
        className={heavyFog ? "lh-haze-bank lh-haze-bank--heavy" : "lh-haze-bank"}
      />
      {Array.from({ length: 58 }).map((_, index) => {
        const x = 64 + ((index * 131) % (width - 128));
        const y = 38 + ((index * 67) % 410);
        const r = 0.7 + (index % 4) * 0.3;
        return <circle key={index} cx={x} cy={y} r={r} fill="oklch(0.98 0 0 / 0.82)" />;
      })}
      <rect x="0" y={model.stage.waterlineY} width={width} height={height - model.stage.waterlineY} fill="url(#lh-cinematic-water)" />
      <rect x="0" y={model.stage.waterlineY} width={width} height={height - model.stage.waterlineY} fill="url(#lh-sea-grid)" opacity="0.56" />
      <path
        d={`M 0 ${model.stage.waterlineY} C 260 ${model.stage.waterlineY - 12} 480 ${model.stage.waterlineY + 10} 704 ${model.stage.waterlineY - 6} C 980 ${model.stage.waterlineY - 24} 1210 ${model.stage.waterlineY + 12} 1480 ${model.stage.waterlineY - 4} C 1650 ${model.stage.waterlineY - 14} 1790 ${model.stage.waterlineY - 3} ${width} ${model.stage.waterlineY - 10}`}
        fill="none"
        stroke="oklch(0.65 0.08 205 / 0.36)"
        strokeWidth="1.4"
        className="lh-waterline"
      />
      <ellipse cx={model.stage.lighthouse.x} cy={model.stage.lighthouse.y + 198} rx="480" ry="82" fill="oklch(0.01 0.012 240 / 0.44)" />
    </g>
  );
}
