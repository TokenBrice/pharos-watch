import {
  DEPENDENCY_TYPE_ORDER,
  DEPENDENCY_TYPE_PRESENTATION,
  TYPE_COLORS,
  TYPE_DASH,
} from "@/components/contagion-graph-model";
import { GRADE_RADAR_COLORS } from "@shared/lib/report-cards";

const GRADE_LEGEND_ITEMS = [
  { label: "Grade A", color: GRADE_RADAR_COLORS.A },
  { label: "Grade B", color: GRADE_RADAR_COLORS.B },
  { label: "Grade C", color: GRADE_RADAR_COLORS.C },
  { label: "Grade D", color: GRADE_RADAR_COLORS.D },
  { label: "Grade F", color: GRADE_RADAR_COLORS.F },
];

export function ContagionGraphLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1">
      {GRADE_LEGEND_ITEMS.map(({ label, color }) => (
        <span key={label} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="inline-block h-3 w-3 rounded-full border-2" style={{ borderColor: color, backgroundColor: "var(--color-card, #f8f9fa)" }} />
          {label}
        </span>
      ))}
      <span className="mx-1 text-border">|</span>
      {DEPENDENCY_TYPE_ORDER.map((type) => (
        // The relationship names are short by necessity; the description carries
        // the plain-English meaning on hover, on both the map and detail pages.
        <span
          key={type}
          className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
          title={DEPENDENCY_TYPE_PRESENTATION[type].description}
        >
          <svg width="16" height="6" className="shrink-0">
            <line x1="0" y1="3" x2="16" y2="3" stroke={TYPE_COLORS[type]} strokeWidth={2} strokeDasharray={TYPE_DASH[type]} />
          </svg>
          {DEPENDENCY_TYPE_PRESENTATION[type].label}
        </span>
      ))}
    </div>
  );
}
