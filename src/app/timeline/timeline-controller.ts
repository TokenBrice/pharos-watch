import { SEVERITY_LABEL_INCLUSIVE, type TapeEventSeverity } from "@shared/types/tape-event";
import {
  TAPE_DEFAULT_SEVERITY,
  type TapeFilterState,
  type TapeWindowKey,
} from "@/components/tape/tape-filters";

export const WINDOW_LABEL: Record<TapeWindowKey, string> = {
  "24h": "last 24h",
  "7d": "last 7 days",
  "30d": "last 30 days",
  "90d": "last 90 days",
  all: "all time",
};

// Compact uppercase form used in the status-line footer.
const WINDOW_SHORT: Record<TapeWindowKey, string> = {
  "24h": "24H",
  "7d": "7D",
  "30d": "30D",
  "90d": "90D",
  all: "ALL",
};

export interface TimelineEventQueryParams {
  type?: string[];
  coin?: string;
  pegCurrency?: string;
  chain?: string;
  severityFloor: TapeEventSeverity;
  since?: number;
  q?: string;
}
export interface TimelineFeedController {
  queryParams: TimelineEventQueryParams;
  filterSignature: string;
  hasActiveFilters: boolean;
  severityLabel: string;
  windowLabel: string;
  windowShort: string;
}

export interface ActiveFilterChip {
  key: string;
  label: string;
  onClear: () => void;
}

export function buildTimelineFilterSignature(filters: TapeFilterState): string {
  return [
    filters.type.join(","),
    filters.severity,
    filters.coin,
    filters.peg,
    filters.chain,
    filters.window,
    filters.q,
  ].join("|");
}

export function buildTimelineFeedController(
  filters: TapeFilterState,
  since: number | undefined,
): TimelineFeedController {
  const hasActiveFilters =
    filters.type.length > 0 ||
    filters.severity !== TAPE_DEFAULT_SEVERITY ||
    filters.coin !== "" ||
    filters.peg !== "all" ||
    filters.chain !== "all" ||
    filters.q !== "" ||
    filters.window !== "7d";

  return {
    queryParams: {
      type: filters.type.length > 0 ? filters.type : undefined,
      coin: filters.coin || undefined,
      pegCurrency: filters.peg !== "all" ? filters.peg : undefined,
      chain: filters.chain !== "all" ? filters.chain : undefined,
      severityFloor: filters.severity,
      since,
      q: filters.q || undefined,
    },
    filterSignature: buildTimelineFilterSignature(filters),
    hasActiveFilters,
    severityLabel: `${SEVERITY_LABEL_INCLUSIVE[filters.severity]} severity`,
    windowLabel: WINDOW_LABEL[filters.window],
    windowShort: WINDOW_SHORT[filters.window],
  };
}

export function buildTimelineResetParams(): Record<string, string> {
  return {
    type: "",
    severity: "",
    coin: "",
    peg: "all",
    chain: "all",
    window: "7d",
    q: "",
  };
}
