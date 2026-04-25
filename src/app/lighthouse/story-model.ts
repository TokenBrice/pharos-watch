import { formatCompactUsd, formatPercent, formatScore, formatSignedPercent } from "@shared/lib/format";
import type { StressSignalsAllResponse } from "@shared/types/market";
import type { StabilityIndexCurrent } from "@shared/types/stability";
import type { LighthouseSceneModel, LighthouseShipRow } from "./view-model";

export type LighthouseChapterId = "harbor" | "lens" | "storm" | "ledger" | "dawn";
export type LighthouseChapterStatus = "available" | "disabled";

export interface LighthouseChapter {
  id: LighthouseChapterId;
  label: string;
  kicker: string;
  summary: string;
  status: LighthouseChapterStatus;
  ariaLabel: string;
  unavailableReason?: string;
}

export interface LighthouseLensSlat {
  key: "severity" | "breadth" | "stressBreadth" | "trend";
  label: string;
  value: number;
  widthPct: number;
  copy: string;
}

export interface LighthouseLensModel {
  score: number;
  band: string;
  scoreLabel: string;
  lightReachPct: number;
  slats: LighthouseLensSlat[];
  computedAt: number;
  methodologyVersion: string;
  caveat: string;
}

export interface LighthouseStormModel {
  warning: number;
  alert: number;
  danger: number;
  totalPressure: number;
  malformedRows: number;
  updatedAt: number;
  oldestComputedAt: number | null;
  caveat: string;
}

export interface LighthouseLedgerFact {
  label: string;
  value: string;
}

export interface LighthouseActionLink {
  label: string;
  href: string;
  detail: string;
}

export interface LighthouseLedgerModel {
  selectedShip: LighthouseShipRow | null;
  facts: LighthouseLedgerFact[];
  selectedChainHref: string | null;
  caveat: string;
}

export interface LighthouseStoryModel {
  chapters: LighthouseChapter[];
  activeChapter: LighthouseChapter;
  activeChapterId: LighthouseChapterId;
  harbor: LighthouseSceneModel;
  lens: LighthouseLensModel | null;
  storm: LighthouseStormModel | null;
  ledger: LighthouseLedgerModel;
  dawnOrders: LighthouseActionLink[];
  unavailableReasons: string[];
}

const CHAPTER_COPY: Record<LighthouseChapterId, Omit<LighthouseChapter, "status" | "ariaLabel" | "unavailableReason">> = {
  harbor: {
    id: "harbor",
    label: "Harbor",
    kicker: "Harbor Below",
    summary: "The beam sweeps the largest chain harbors by tracked stablecoin supply.",
  },
  lens: {
    id: "lens",
    label: "Lens",
    kicker: "Lens Room",
    summary: "PSI powers the light source; components become lens shutters, not a new score.",
  },
  storm: {
    id: "storm",
    label: "Storm",
    kicker: "Storm Watch",
    summary: "DEWS pressure appears as aggregate horizon weather, not chain-level causality.",
  },
  ledger: {
    id: "ledger",
    label: "Ledger",
    kicker: "Harbor Master's Ledger",
    summary: "The selected harbor resolves into exact supply, cargo, health, wake, and route links.",
  },
  dawn: {
    id: "dawn",
    label: "Orders",
    kicker: "Dawn Orders",
    summary: "Move from the story surface into the deeper Pharos workbenches.",
  },
};

function clampPct(value: number, max = 100): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, (Math.abs(value) / max) * 100));
}

function resolveChapterId(chapterId: string | null | undefined): LighthouseChapterId {
  if (
    chapterId === "harbor" ||
    chapterId === "lens" ||
    chapterId === "storm" ||
    chapterId === "ledger" ||
    chapterId === "dawn"
  ) {
    return chapterId;
  }
  return "harbor";
}

function buildLensModel(stabilityIndex: StabilityIndexCurrent | null | undefined): LighthouseLensModel | null {
  if (!stabilityIndex) return null;
  const components = stabilityIndex.components;
  const slats: LighthouseLensSlat[] = [
    {
      key: "severity",
      label: "Severity",
      value: components.severity,
      widthPct: clampPct(components.severity, 40),
      copy: "Peg deviation pressure in the current PSI sample.",
    },
    {
      key: "breadth",
      label: "Breadth",
      value: components.breadth,
      widthPct: clampPct(components.breadth, 40),
      copy: "How widely stress is distributed across the tracked market.",
    },
    {
      key: "trend",
      label: "Trend",
      value: components.trend,
      widthPct: clampPct(components.trend, 30),
      copy: "Direction of market condition change.",
    },
  ];

  if (components.stressBreadth != null) {
    slats.splice(2, 0, {
      key: "stressBreadth",
      label: "DEWS breadth",
      value: components.stressBreadth,
      widthPct: clampPct(components.stressBreadth, 30),
      copy: "DEWS contribution inside the published PSI calculation.",
    });
  }

  return {
    score: stabilityIndex.score,
    band: stabilityIndex.band,
    scoreLabel: `${stabilityIndex.band} ${formatScore(stabilityIndex.score)}`,
    lightReachPct: clampPct(stabilityIndex.score),
    slats,
    computedAt: stabilityIndex.computedAt,
    methodologyVersion: stabilityIndex.methodologyVersion,
    caveat: "Lens visuals use the published PSI score and components only; they do not create a second market score.",
  };
}

export function buildStormModel(stressSignals: StressSignalsAllResponse | null | undefined): LighthouseStormModel | null {
  const entries = Object.values(stressSignals?.signals ?? {});
  if (entries.length === 0 || !stressSignals) return null;

  let warning = 0;
  let alert = 0;
  let danger = 0;
  for (const entry of entries) {
    if (entry.band === "DANGER") danger++;
    else if (entry.band === "ALERT") alert++;
    else if (entry.band === "WARNING") warning++;
  }

  const totalPressure = warning + alert + danger;
  return {
    warning,
    alert,
    danger,
    totalPressure,
    malformedRows: stressSignals.malformedRows ?? 0,
    updatedAt: stressSignals.updatedAt,
    oldestComputedAt: stressSignals.oldestComputedAt ?? null,
    caveat: "Storm signals are aggregate DEWS counts across stablecoins; they are not assigned to the selected chain harbor.",
  };
}

function buildLedgerModel(scene: LighthouseSceneModel): LighthouseLedgerModel {
  const ship = scene.selectedShip;
  return {
    selectedShip: ship,
    selectedChainHref: ship ? `/chains/${encodeURIComponent(ship.id)}/` : null,
    facts: ship
      ? [
          { label: "Supply", value: formatCompactUsd(ship.totalUsd) },
          { label: "Tracked Share", value: formatPercent(ship.sharePct, 1) },
          { label: "Health", value: ship.healthBand ?? "unrated" },
          { label: "Dominant Cargo", value: `${ship.dominantSymbol} ${formatPercent(ship.dominantSharePct, 1)}` },
          { label: "7d Wake", value: formatSignedPercent(ship.change7dPct * 100, 1) },
          { label: "Tracked Coins", value: String(ship.stablecoinCount) },
        ]
      : [],
    caveat: "The ledger repeats the harbor data in text form so the visual metaphor stays auditable.",
  };
}

function buildDawnOrders(scene: LighthouseSceneModel): LighthouseActionLink[] {
  const selected = scene.selectedShip;
  return [
    ...(selected
      ? [
          {
            label: `Open ${selected.name}`,
            href: `/chains/${encodeURIComponent(selected.id)}/`,
            detail: "Inspect the selected chain harbor in the full chain workbench.",
          },
        ]
      : []),
    {
      label: "Chain Harbors",
      href: "/chains/",
      detail: "Compare the full chain fleet behind this scene.",
    },
    {
      label: "Stability Index",
      href: "/stability-index/",
      detail: "Read the PSI score and component history that powers the lens.",
    },
    {
      label: "DEWS Radar",
      href: "/depeg/",
      detail: "Review active depeg and stress signals behind the storm watch.",
    },
  ];
}

function chapterAvailability({
  id,
  scene,
  lens,
  storm,
}: {
  id: LighthouseChapterId;
  scene: LighthouseSceneModel;
  lens: LighthouseLensModel | null;
  storm: LighthouseStormModel | null;
}): Pick<LighthouseChapter, "status" | "unavailableReason"> {
  if (id === "harbor" && scene.ships.length === 0) {
    return { status: "disabled", unavailableReason: "chain-data-unavailable" };
  }
  if (id === "lens" && !lens) {
    return { status: "disabled", unavailableReason: "psi-unavailable" };
  }
  if (id === "storm" && !storm) {
    return { status: "disabled", unavailableReason: "stress-signals-unavailable" };
  }
  if (id === "ledger" && !scene.selectedShip) {
    return { status: "disabled", unavailableReason: "selected-harbor-unavailable" };
  }
  return { status: "available" };
}

export function buildLighthouseStoryModel({
  scene,
  stabilityIndex,
  stressSignals,
  activeChapterId,
}: {
  scene: LighthouseSceneModel;
  stabilityIndex: StabilityIndexCurrent | null | undefined;
  stressSignals: StressSignalsAllResponse | null | undefined;
  activeChapterId: string | null | undefined;
  selectedId?: string | null;
}): LighthouseStoryModel {
  const lens = buildLensModel(stabilityIndex);
  const storm = buildStormModel(stressSignals);
  const ids: LighthouseChapterId[] = ["harbor", "lens", "storm", "ledger", "dawn"];
  const unavailableReasons: string[] = [];
  const chapters = ids.map((id) => {
    const availability = chapterAvailability({ id, scene, lens, storm });
    if (availability.unavailableReason) unavailableReasons.push(availability.unavailableReason);
    return {
      ...CHAPTER_COPY[id],
      ...availability,
      ariaLabel: `${CHAPTER_COPY[id].kicker}: ${CHAPTER_COPY[id].summary}`,
    };
  });

  const requestedId = resolveChapterId(activeChapterId);
  const requestedChapter = chapters.find((chapter) => chapter.id === requestedId);
  const activeChapter = requestedChapter?.status === "available"
    ? requestedChapter
    : chapters.find((chapter) => chapter.id === "harbor") ?? chapters[0]!;

  return {
    chapters,
    activeChapter,
    activeChapterId: activeChapter.id,
    harbor: scene,
    lens,
    storm,
    ledger: buildLedgerModel(scene),
    dawnOrders: buildDawnOrders(scene),
    unavailableReasons,
  };
}
