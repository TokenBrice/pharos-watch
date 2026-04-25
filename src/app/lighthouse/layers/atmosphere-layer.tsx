import type { LighthouseCinematicModel } from "../cinematic-model";

export function AtmosphereLayer({
  model,
}: {
  model: LighthouseCinematicModel;
}) {
  const heavyFog = model.harbors.fogBand === "fog";
  return (
    <g aria-hidden="true" className="lh-atmosphere-layer">
      <rect x="0" y="0" width="1440" height="900" fill="url(#lh-night-sky)" />
      <path
        d="M 0 506 C 170 480 294 507 430 490 C 616 468 784 492 950 472 C 1120 452 1265 468 1440 438 L 1440 650 L 0 650 Z"
        fill="oklch(0.84 0.026 245 / 0.065)"
        className={heavyFog ? "lh-haze-bank lh-haze-bank--heavy" : "lh-haze-bank"}
      />
      {Array.from({ length: 38 }).map((_, index) => {
        const x = 60 + ((index * 97) % 1320);
        const y = 36 + ((index * 53) % 300);
        const r = 0.7 + (index % 4) * 0.3;
        return <circle key={index} cx={x} cy={y} r={r} fill="oklch(0.98 0 0 / 0.82)" />;
      })}
      <rect x="0" y={model.stage.waterlineY} width="1440" height="265" fill="url(#lh-cinematic-water)" />
      <rect x="0" y={model.stage.waterlineY} width="1440" height="265" fill="url(#lh-sea-grid)" opacity="0.56" />
      <path
        d={`M 0 ${model.stage.waterlineY} C 210 ${model.stage.waterlineY - 9} 330 ${model.stage.waterlineY + 8} 516 ${model.stage.waterlineY - 5} C 744 ${model.stage.waterlineY - 21} 900 ${model.stage.waterlineY + 9} 1110 ${model.stage.waterlineY - 4} C 1236 ${model.stage.waterlineY - 12} 1348 ${model.stage.waterlineY - 2} 1440 ${model.stage.waterlineY - 9}`}
        fill="none"
        stroke="oklch(0.65 0.08 205 / 0.36)"
        strokeWidth="1.4"
        className="lh-waterline"
      />
      <ellipse cx="720" cy="782" rx="380" ry="70" fill="oklch(0.01 0.012 240 / 0.44)" />
    </g>
  );
}
