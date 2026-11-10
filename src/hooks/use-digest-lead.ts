"use client";

import { useState } from "react";
import { useDailyDigest, useDigestArchive } from "@/hooks/api-hooks";
import { formatLongDate } from "@shared/lib/format";
import type { DigestContentEntry } from "@shared/types";

export function digestDateSlug(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/**
 * Pick the displayed lead once, for both the archive lead and the masthead, so
 * the nameplate's issue number and date always describe that same edition.
 * `initialLead` holds the first render until a newer live edition arrives.
 */
export function useDigestLead(initialLead?: DigestContentEntry) {
  const [seed] = useState(initialLead);
  const archiveQuery = useDigestArchive();
  const { data: dailyLead } = useDailyDigest();
  const archiveLead = seed ? archiveQuery.data?.digests.find((entry) => entry.digestType !== "weekly") : null;
  const liveLead = archiveLead && (!dailyLead?.digest || !dailyLead.generatedAt || archiveLead.generatedAt > dailyLead.generatedAt)
    ? { ...archiveLead, digest: archiveLead.digestText }
    : dailyLead;
  const liveSlug = liveLead?.digest && liveLead.generatedAt ? digestDateSlug(liveLead.generatedAt) : null;
  const seedData = seed ? {
    digest: seed.text, digestTitle: seed.title, digestExtended: seed.extended, generatedAt: seed.generatedAt,
  } : null;
  const lead = liveSlug && (!seed || liveSlug > seed.date) ? liveLead : seedData && liveSlug === seed?.date ? {
    ...seedData,
    riskSignal: liveLead?.riskSignal,
    riskTape: liveLead?.riskTape,
    nextTriggers: liveLead?.nextTriggers,
  } : seedData;
  const leadSlug = lead?.generatedAt ? digestDateSlug(lead.generatedAt) : null;
  const leadDate = lead?.generatedAt ? formatLongDate(new Date(lead.generatedAt * 1000), { utc: true }) : null;
  // The nameplate reads the source edition actually displayed, never a separate read.
  const showsLiveEdition = liveSlug !== null && (!seed || liveSlug > seed.date);
  const editionNumber = showsLiveEdition ? (liveLead?.editionNumber ?? null) : (seed?.editionNumber ?? null);
  const editionDate = showsLiveEdition ? liveSlug : (seed?.date ?? null);
  return { lead, leadSlug, leadDate, editionNumber, editionDate, archiveQuery };
}
