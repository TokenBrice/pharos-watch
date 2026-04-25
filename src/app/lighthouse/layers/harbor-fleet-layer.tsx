import type { CSSProperties, KeyboardEvent } from "react";
import type { LighthouseHarborMark, LighthouseTailMark } from "../cinematic-model";

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function routePath(harbor: LighthouseHarborMark, origin: { x: number; y: number }) {
  const sternY = harbor.y + harbor.hullHeight * 0.72;
  const controlY = origin.y - 76 - harbor.rank * 4;
  return `M ${origin.x} ${origin.y} C ${(origin.x + harbor.x) / 2} ${controlY} ${(origin.x + harbor.x) / 2} ${controlY} ${harbor.x} ${sternY}`;
}

function HarborBasin({ harbors }: { harbors: LighthouseHarborMark[] }) {
  if (harbors.length === 0) return null;

  const selected = harbors.find((harbor) => harbor.isSelected) ?? harbors[0];
  const minX = Math.min(...harbors.map((harbor) => harbor.x - harbor.hullWidth * 0.62));
  const maxX = Math.max(...harbors.map((harbor) => harbor.x + harbor.hullWidth * 0.62));
  const maxY = Math.max(...harbors.map((harbor) => harbor.y + harbor.hullHeight));
  const centerX = Math.round((minX + maxX) / 2);
  const basinY = Math.round(maxY + 42);
  const basinWidth = Math.max(620, Math.round(maxX - minX + 250));
  const left = centerX - basinWidth / 2;
  const right = centerX + basinWidth / 2;
  const origin = { x: centerX, y: basinY - 28 };

  return (
    <g
      className="lh-harbor-basin"
      aria-hidden="true"
      style={{ "--lh-harbor-color": selected?.healthColorHex ?? "#38bdf8" } as CSSProperties}
    >
      <ellipse className="lh-harbor-basin-shadow" cx={centerX} cy={basinY + 82} rx={basinWidth * 0.43} ry="46" />
      <path
        className="lh-harbor-basin-shelf"
        d={`M ${left + 30} ${basinY - 18} C ${left + basinWidth * 0.19} ${basinY - 92} ${right - basinWidth * 0.24} ${basinY - 96} ${right - 42} ${basinY - 20} C ${right - 118} ${basinY + 74} ${left + 112} ${basinY + 76} ${left + 30} ${basinY - 18} Z`}
      />
      <path
        className="lh-harbor-basin-water"
        d={`M ${left + 92} ${basinY - 4} C ${left + basinWidth * 0.28} ${basinY - 54} ${right - basinWidth * 0.28} ${basinY - 54} ${right - 92} ${basinY - 4} C ${right - 162} ${basinY + 42} ${left + 162} ${basinY + 42} ${left + 92} ${basinY - 4} Z`}
      />
      <path
        className="lh-harbor-breakwater lh-harbor-breakwater--left"
        d={`M ${left + 68} ${basinY - 20} C ${left + 154} ${basinY - 56} ${left + 236} ${basinY - 62} ${left + 318} ${basinY - 46}`}
      />
      <path
        className="lh-harbor-breakwater lh-harbor-breakwater--right"
        d={`M ${right - 318} ${basinY - 46} C ${right - 230} ${basinY - 64} ${right - 148} ${basinY - 58} ${right - 68} ${basinY - 20}`}
      />
      {harbors.map((harbor) => (
        <g
          key={harbor.id}
          className={classNames("lh-harbor-route-set", harbor.isSelected && "lh-harbor-route-set--selected")}
          style={{ "--lh-harbor-color": harbor.healthColorHex } as CSSProperties}
        >
          <path
            className={classNames("lh-harbor-route", harbor.isSelected && "lh-harbor-route--selected")}
            d={routePath(harbor, origin)}
            fill="none"
            strokeWidth={Math.max(1.15, Math.min(4.4, harbor.hullWidth / 62))}
            strokeOpacity={0.12 + Math.min(0.22, harbor.sharePct / 360)}
          />
          <ellipse
            className={classNames("lh-harbor-berth", harbor.isSelected && "lh-harbor-berth--selected")}
            cx={harbor.x}
            cy={harbor.y + harbor.hullHeight * 0.66}
            rx={Math.max(40, harbor.hullWidth * 0.6)}
            ry={Math.max(12, harbor.hullHeight * 0.36)}
          />
        </g>
      ))}
      {selected ? (
        <g
          className="lh-harbor-selected-water"
          style={{ "--lh-harbor-color": selected.healthColorHex } as CSSProperties}
        >
          <ellipse
            className="lh-harbor-ripple lh-harbor-ripple--outer"
            cx={selected.x}
            cy={selected.y + selected.hullHeight * 0.78}
            rx={Math.max(82, selected.hullWidth * 0.78)}
            ry={Math.max(22, selected.hullHeight * 0.48)}
          />
          <ellipse
            className="lh-harbor-ripple lh-harbor-ripple--inner"
            cx={selected.x}
            cy={selected.y + selected.hullHeight * 0.78}
            rx={Math.max(54, selected.hullWidth * 0.54)}
            ry={Math.max(15, selected.hullHeight * 0.34)}
          />
        </g>
      ) : null}
    </g>
  );
}

function Wake({ harbor }: { harbor: LighthouseHarborMark }) {
  if (harbor.wakeDirection === 0) return null;
  const sign = harbor.wakeDirection > 0 ? -1 : 1;
  const length = 42 + Math.abs(harbor.wakeLength) * 146;
  return (
    <path
      className="lh-harbor-wake"
      d={`M ${-sign * 36} 32 C ${-sign * 70} 46 ${-sign * length} 34 ${-sign * (length + 38)} 48`}
      fill="none"
      stroke={harbor.wakeDirection > 0 ? "oklch(0.72 0.15 155 / 0.46)" : "oklch(0.7 0.16 30 / 0.44)"}
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    />
  );
}

function HarborMark({
  harbor,
  onSelect,
  onPreview,
  onPreviewEnd,
}: {
  harbor: LighthouseHarborMark;
  onSelect: (id: string) => void;
  onPreview?: (id: string) => void;
  onPreviewEnd?: () => void;
}) {
  const handleKeyDown = (event: KeyboardEvent<SVGGElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect(harbor.id);
  };
  const hullW = harbor.hullWidth;
  const hullH = harbor.hullHeight;
  const lightCount = Math.max(2, Math.min(7, Math.ceil(harbor.stablecoinCount / 9)));
  const cargoSlots = Array.from({ length: harbor.cargoCount });
  const deckLights = Array.from({ length: lightCount });

  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={harbor.ariaLabel}
      aria-pressed={harbor.isSelected}
      data-harbor-id={harbor.id}
      data-testid={`lighthouse-harbor-${harbor.id}`}
      className={classNames("lh-harbor-mark", harbor.isSelected && "lh-harbor-mark--selected")}
      transform={`translate(${harbor.x} ${harbor.y})`}
      onClick={() => onSelect(harbor.id)}
      onKeyDown={handleKeyDown}
      onPointerEnter={() => onPreview?.(harbor.id)}
      onPointerLeave={() => onPreviewEnd?.()}
      onFocus={() => onPreview?.(harbor.id)}
      onBlur={() => onPreviewEnd?.()}
      style={
        {
          "--lh-harbor-color": harbor.healthColorHex,
        } as CSSProperties
      }
    >
      <title>{harbor.ariaLabel}</title>
      <rect
        x={-hullW / 2 - 32}
        y={-harbor.mastHeight - 42}
        width={hullW + 64}
        height={harbor.mastHeight + 114}
        rx="18"
        fill="transparent"
      />
      <ellipse
        className="lh-harbor-focus-ring"
        cx="0"
        cy={hullH * 0.6}
        rx={Math.max(46, hullW * 0.62)}
        ry={Math.max(20, hullH * 0.52)}
      />
      <Wake harbor={harbor} />
      <ellipse
        cx="0"
        cy="46"
        rx={Math.max(28, hullW * 0.55)}
        ry="10"
        fill={harbor.healthColorHex}
        opacity="0.15"
        className="lh-harbor-reflection"
      />
      <g className="lh-harbor-ship-body">
        <path
          d={`M ${-hullW / 2} 2 L ${hullW / 2 - 12} 2 Q ${hullW / 2 + 10} ${hullH * 0.34} ${hullW / 2 - 4} ${hullH} L ${-hullW / 2 + 12} ${hullH} Q ${-hullW / 2 - 12} ${hullH * 0.54} ${-hullW / 2} 2 Z`}
          fill="url(#lh-ship-hull)"
          stroke={harbor.healthColorHex}
          strokeOpacity="0.56"
          strokeWidth="1.35"
          className="lh-harbor-hull"
        />
        <path
          d={`M ${-hullW / 2 + 16} ${hullH * 0.32} C ${-hullW * 0.18} ${hullH * 0.45} ${hullW * 0.2} ${hullH * 0.42} ${hullW / 2 - 20} ${hullH * 0.26}`}
          fill="none"
          stroke="oklch(0.88 0.035 86 / 0.34)"
          strokeWidth="1"
          className="lh-harbor-deck-line"
        />
        {cargoSlots.map((_, index) => {
          const spacing = hullW / (harbor.cargoCount + 1);
          return (
            <rect
              key={index}
              x={-hullW / 2 + spacing * (index + 1) - 5}
              y={-11 - (index % 2) * 5}
              width="10"
              height="10"
              rx="2"
              fill={harbor.healthColorHex}
              opacity={index === 0 ? 0.95 : 0.62}
              className="lh-harbor-cargo"
            />
          );
        })}
        {deckLights.map((_, index) => {
          const spacing = hullW / (lightCount + 1);
          return (
            <circle
              key={index}
              cx={-hullW / 2 + spacing * (index + 1)}
              cy={hullH * 0.55 + (index % 2) * 3}
              r="2.1"
              fill={harbor.healthColorHex}
              opacity={0.18 + Math.min(0.42, harbor.sharePct / 180)}
              className="lh-harbor-deck-light"
            />
          );
        })}
        <line x1="0" y1="0" x2="0" y2={-harbor.mastHeight} stroke="oklch(0.91 0.025 250 / 0.72)" strokeWidth="2" />
        <path
          d={`M 0 ${-harbor.mastHeight + 10} L ${harbor.pennantWidth} ${-harbor.mastHeight + 20} L 0 ${-harbor.mastHeight + 32} Z`}
          fill={harbor.healthColorHex}
          opacity="0.82"
          className="lh-harbor-pennant"
        />
        <path
          d={`M 0 -14 C ${-hullW * 0.2} -44 ${-hullW * 0.18} ${-harbor.mastHeight + 28} 0 ${-harbor.mastHeight + 42} C ${hullW * 0.22} ${-harbor.mastHeight + 22} ${hullW * 0.28} -40 0 -14 Z`}
          fill="url(#lh-sail-gradient)"
          opacity="0.8"
          className="lh-harbor-sail"
        />
        <circle
          cx="0"
          cy={-harbor.mastHeight - 17}
          r={harbor.isSelected ? 24 : 18}
          fill={harbor.healthColorHex}
          opacity="0.08"
          className="lh-harbor-signal-aura"
        />
        <circle
          cx="0"
          cy={-harbor.mastHeight - 17}
          r={harbor.isSelected ? 18 : 14}
          fill="oklch(0.025 0.018 245 / 0.9)"
          stroke={harbor.healthColorHex}
          strokeWidth={harbor.isSelected ? 3 : 2}
          className="lh-harbor-signal"
        />
        <image
          href={harbor.logoPath}
          x="-10"
          y={-harbor.mastHeight - 27}
          width="20"
          height="20"
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
        />
      </g>
      <g className="lh-harbor-draft-lines">
        {Array.from({ length: harbor.draftLayers }).map((_, index) => (
          <path
            key={index}
            d={`M ${-hullW * 0.42} ${hullH + 8 + index * 8} C ${-hullW * 0.14} ${hullH + 14 + index * 8} ${hullW * 0.12} ${hullH + 12 + index * 8} ${hullW * 0.42} ${hullH + 8 + index * 8}`}
            fill="none"
            stroke={harbor.healthColorHex}
            strokeOpacity={0.18 + index * 0.06}
            strokeWidth="1"
          />
        ))}
      </g>
    </g>
  );
}

function TailFleet({ tail }: { tail: LighthouseTailMark | null }) {
  if (!tail) return null;
  const opacity = 0.16 + Math.min(0.24, tail.remainingSharePct * 0.8);
  const firstLight = tail.lights[0] ?? { x: 136, y: 604 };
  const middleLight = tail.lights[Math.floor(tail.lights.length / 2)] ?? { x: 486, y: firstLight.y };
  const lastLight = tail.lights[tail.lights.length - 1] ?? { x: 802, y: 612 };
  return (
    <g className="lh-tail-fleet" aria-label={tail.ariaLabel}>
      <title>{tail.ariaLabel}</title>
      <path
        className="lh-tail-fleet-horizon"
        d={`M ${firstLight.x} ${firstLight.y + 18} C ${middleLight.x} ${firstLight.y + 2} ${lastLight.x} ${lastLight.y + 10} ${lastLight.x + 42} ${lastLight.y + 20}`}
        fill="none"
      />
      {tail.lights.map((light, index) => (
        <circle
          key={index}
          cx={light.x}
          cy={light.y}
          r={index % 4 === 0 ? 4 : 3}
          fill="oklch(0.75 0.05 205)"
          opacity={opacity}
        />
      ))}
    </g>
  );
}

export function HarborFleetLayer({
  harbors,
  tail,
  onSelect,
  onPreview,
  onPreviewEnd,
}: {
  harbors: LighthouseHarborMark[];
  tail: LighthouseTailMark | null;
  onSelect: (id: string) => void;
  onPreview?: (id: string) => void;
  onPreviewEnd?: () => void;
}) {
  const hasSelection = harbors.some((harbor) => harbor.isSelected);
  return (
    <g className={classNames("lh-harbor-fleet-layer", hasSelection && "lh-harbor-fleet-layer--has-selection")}>
      <HarborBasin harbors={harbors} />
      <TailFleet tail={tail} />
      {harbors.map((harbor) => (
        <HarborMark
          key={harbor.id}
          harbor={harbor}
          onSelect={onSelect}
          onPreview={onPreview}
          onPreviewEnd={onPreviewEnd}
        />
      ))}
    </g>
  );
}
