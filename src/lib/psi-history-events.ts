import { PSI_HEX_COLORS } from "@shared/lib/psi-colors";

export interface PsiEventLink {
  title: string;
  url: string;
}

export interface PsiEvent {
  date: number;
  dateEnd?: number;
  label: string;
  links: readonly PsiEventLink[];
}

export const BAND_ZONES = [
  { y1: 90, y2: 100, color: PSI_HEX_COLORS.BEDROCK, label: "BEDROCK" },
  { y1: 75, y2: 90, color: PSI_HEX_COLORS.STEADY, label: "STEADY" },
  { y1: 60, y2: 75, color: PSI_HEX_COLORS.TREMOR, label: "TREMOR" },
  { y1: 40, y2: 60, color: PSI_HEX_COLORS.FRACTURE, label: "FRACTURE" },
  { y1: 20, y2: 40, color: PSI_HEX_COLORS.CRISIS, label: "CRISIS" },
  { y1: 0, y2: 20, color: PSI_HEX_COLORS.MELTDOWN, label: "MELTDOWN" },
] as const;

export const PSI_EVENTS: readonly PsiEvent[] = [
  {
    date: Date.UTC(2018, 9, 14),
    dateEnd: Date.UTC(2018, 9, 26),
    label: "Tether Scare",
    links: [
      {
        title: "USDT dropped to $0.90 on some exchanges amid Bitfinex withdrawal concerns",
        url: "https://www.coindesk.com/markets/2018/10/15/tether-crypto-usd-stablecoin-drops-to-96-cents",
      },
    ],
  },
  {
    date: Date.UTC(2019, 1, 3),
    dateEnd: Date.UTC(2019, 1, 9),
    label: "QuadrigaCX Collapse",
    links: [
      {
        title: "QuadrigaCX filed for creditor protection after founder's death left C$260M inaccessible",
        url: "https://www.osc.ca/quadrigacxreport/",
      },
      {
        title: "Flight-to-quality panic: USDC hit +6.25% premium while sUSD crashed 25%",
        url: "https://www.nortonrosefulbright.com/en/knowledge/publications/168bc350/quadriga-bankruptcy",
      },
    ],
  },
  {
    date: Date.UTC(2019, 3, 25),
    dateEnd: Date.UTC(2019, 3, 30),
    label: "Bitfinex NY AG",
    links: [
      {
        title: "NY AG accused Bitfinex of hiding $850M in losses covered by Tether reserves",
        url: "https://ag.ny.gov/press-release/2019/attorney-general-james-announces-court-order-against-crypto-currency-company",
      },
      {
        title: "Flight from USDT: USDC, TUSD, and USDP traded 1.5-3.4% above peg for days",
        url: "https://www.coindesk.com/markets/2019/04/26/tether-says-its-cryptocurrency-is-only-74-backed-by-cash-and-securities",
      },
    ],
  },
  {
    date: Date.UTC(2020, 2, 12),
    dateEnd: Date.UTC(2020, 2, 16),
    label: "COVID Crash",
    links: [
      {
        title: "BTC crashed 50% in one day; DAI hit $1.06+ as MakerDAO liquidations spiraled",
        url: "https://www.coindesk.com/markets/2020/03/12/bitcoin-price-drops-to-lowest-since-may-2019-as-global-rout-deepens",
      },
      {
        title: "MakerDAO's Black Thursday: $8.3M in DAI auctioned for essentially zero collateral",
        url: "https://medium.com/@whiterabbit_hq/black-thursday-for-makerdao-8-32-million-was-liquidated-for-0-dai-36b83cac56b6",
      },
    ],
  },
  {
    date: Date.UTC(2021, 0, 4),
    dateEnd: Date.UTC(2021, 0, 6),
    label: "BTC ATH Crash",
    links: [
      {
        title: "BTC crashed 17% from $34K to $28K; USDC dropped to $0.98, broad stablecoin stress",
        url: "https://www.coindesk.com/markets/2021/01/04/bitcoin-drops-17-from-record-high-bringing-a-sense-of-normalcy-to-crypto",
      },
    ],
  },
  {
    date: Date.UTC(2021, 6, 26),
    dateEnd: Date.UTC(2021, 7, 1),
    label: "Tether DOJ Probe",
    links: [
      {
        title: "DOJ opened criminal investigation into Tether executives for bank fraud",
        url: "https://www.cnbc.com/2021/07/26/doj-reportedly-probes-crypto-company-tether-for-possible-bank-fraud.html",
      },
      {
        title: "Broad stablecoin depeg: 10 coins depegged simultaneously as market panicked",
        url: "https://fortune.com/2021/07/26/tether-crypto-bank-fraud-doj-investigation/",
      },
    ],
  },
  {
    date: Date.UTC(2022, 0, 21),
    dateEnd: Date.UTC(2022, 1, 8),
    label: "Fed Crash",
    links: [
      {
        title: "BTC crashed from $43K to $35K as Fed signaled aggressive rate hikes",
        url: "https://www.washingtonpost.com/business/2022/01/22/crypto-crash-bitcoin-fed/",
      },
      {
        title: "Chicago Fed retrospective on the crypto runs of 2022",
        url: "https://www.chicagofed.org/publications/chicago-fed-letter/2023/479",
      },
    ],
  },
  {
    date: Date.UTC(2022, 4, 7),
    dateEnd: Date.UTC(2022, 6, 1),
    label: "UST Collapse",
    links: [
      {
        title: "Terra/Luna algorithmic stablecoin death spiral wiped $45B",
        url: "https://www.coindesk.com/learn/the-fall-of-terra-a-timeline-of-the-meteoric-rise-and-crash-of-ust-and-luna/",
      },
    ],
  },
  {
    date: Date.UTC(2023, 2, 10),
    dateEnd: Date.UTC(2023, 2, 16),
    label: "SVB Weekend",
    links: [
      {
        title: "USDC depegged to $0.88 after $3.3B stuck in collapsed Silicon Valley Bank",
        url: "https://www.coindesk.com/markets/2023/03/11/usdc-depegs-from-dollar-stablecoin-drops-below-090/",
      },
    ],
  },
] as const;
export type PsiEventLabelPosition = "top" | "insideBottom";
export type PsiVisibleEvent = PsiEvent & { hideLabel: boolean; position: PsiEventLabelPosition };

const PSI_EVENT_LABEL_POSITIONS: readonly PsiEventLabelPosition[] = ["top", "insideBottom"] as const;
const DEFAULT_HIDE_THRESHOLD_RATIO = 0.05;

function getPsiEventLabelPosition(index: number): PsiEventLabelPosition {
  return PSI_EVENT_LABEL_POSITIONS[index % PSI_EVENT_LABEL_POSITIONS.length] ?? "top";
}

export function buildVisiblePsiChartEvents(
  events: readonly PsiEvent[],
  min?: number,
  max?: number,
  thresholdRatio = DEFAULT_HIDE_THRESHOLD_RATIO,
): PsiVisibleEvent[] {
  const orderedEvents = [...events].sort((a, b) => a.date - b.date);
  const visibleEvents = min === undefined || max === undefined
    ? orderedEvents
    : orderedEvents.filter((event) => event.date <= max && (event.dateEnd ?? event.date) >= min);
  const rangeMs = min === undefined || max === undefined ? 0 : max - min;
  const threshold = rangeMs * thresholdRatio;
  const lastShownEndByPosition: Partial<Record<PsiEventLabelPosition, number>> = {};

  return visibleEvents.map((event, index) => {
    const position = getPsiEventLabelPosition(index);
    const lastEnd = lastShownEndByPosition[position] ?? -Infinity;
    const hideLabel = event.date - lastEnd < threshold;

    if (!hideLabel) {
      lastShownEndByPosition[position] = event.dateEnd ?? event.date;
    }

    return {
      ...event,
      hideLabel,
      position,
    };
  });
}
