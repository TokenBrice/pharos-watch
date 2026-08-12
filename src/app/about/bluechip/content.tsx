import type { ReactNode } from "react";

export interface BluechipGate {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

export interface BluechipRefusal {
  readonly title: string;
  readonly body: string;
}

export const BLUECHIP_LEDE: ReactNode =
  "Pharos Bluechip is an editorial roster built from external Bluechip reference ratings intersected with Pharos report-card grades. A coin appears here only when Bluechip's synced rating is A-tier and Pharos independently rates the same asset A-tier or better.";

export const BLUECHIP_WHAT_IT_MEANS: readonly string[] = [
  "The Bluechip grade itself comes from the external Bluechip data sync. Pharos does not recompute that methodology or expose a hidden Bluechip score; it stores the synced grade, date, and reference metadata as a separate input.",
  "The roster adds a Pharos guardrail on top of that input. If an asset is not A-tier in Pharos report cards, it stays out of this page even when the external Bluechip feed still carries a high grade. That keeps the page from presenting an external rating as if it were a Pharos-owned floor result.",
];

export const BLUECHIP_GATES: readonly BluechipGate[] = [
  {
    id: "external-bluechip-tier",
    title: "External Bluechip tier",
    body: "The synced Bluechip reference rating must be A-tier. Pharos treats that grade as source data, not as a locally recomputed methodology.",
  },
  {
    id: "pharos-report-card-tier",
    title: "Pharos report-card tier",
    body: "The same asset must also hold an A-tier Pharos V9 grade (A-, A, or A+). This independent filter reflects Backing, Exit, and Economic Control, constrained by peg behavior, dependency exposure, evidence quality, and structural caps.",
  },
  {
    id: "tracked-asset-match",
    title: "Tracked asset match",
    body: "The Bluechip entry must resolve to a Pharos-tracked stablecoin ID. Unmatched feed rows stay out of the public roster until the mapping is explicit.",
  },
  {
    id: "fresh-reference-data",
    title: "Fresh reference data",
    body: "The roster is refreshed from the Bluechip sync and Pharos report-card API. Stale or unavailable inputs fail closed rather than inventing a substitute grade.",
  },
  {
    id: "no-local-score-blend",
    title: "No local score blend",
    body: "Pharos does not average the external Bluechip grade with its own score. The roster is an intersection: both systems must currently clear the A-tier threshold.",
  },
];

export const BLUECHIP_REFUSALS: readonly BluechipRefusal[] = [
  {
    title: "No unmapped external rows",
    body: "A Bluechip feed row without a stable Pharos coin mapping is not shown as an active roster member.",
  },
  {
    title: "No Pharos-only promotions",
    body: "An A-tier Pharos report card alone is not enough. The external Bluechip rating must also be A-tier.",
  },
  {
    title: "No external-only promotions",
    body: "An A-tier external Bluechip rating alone is not enough. The Pharos report-card grade must also be A-tier.",
  },
  {
    title: "No hidden methodology",
    body: "This page does not claim a separate Pharos Bluechip formula. Methodology details for Pharos grades live in the report-card documentation; Bluechip grade semantics come from the external source.",
  },
  {
    title: "No stale roster carry",
    body: "If either feed is unavailable or stops clearing the A-tier threshold, the asset is removed from this active roster until both inputs recover.",
  },
];
