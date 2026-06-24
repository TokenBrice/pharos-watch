"use client";

import { useEffect, useState } from "react";

export interface ReleaseMetadata {
  commit: string | null;
  runId: string | null;
  runAttempt: string | null;
  createdAt: string | null;
  createdAtSec: number | null;
}

export interface ReleaseMetadataState {
  status: "loading" | "ready" | "unavailable";
  metadata: ReleaseMetadata | null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function parseReleaseMetadata(value: unknown): ReleaseMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const createdAt = readString(record.createdAt);
  const createdAtMs = createdAt ? Date.parse(createdAt) : Number.NaN;

  return {
    commit: readString(record.commit),
    runId: readString(record.runId),
    runAttempt: readString(record.runAttempt),
    createdAt,
    createdAtSec: Number.isFinite(createdAtMs) ? Math.floor(createdAtMs / 1000) : null,
  };
}

export function useReleaseMetadata(): ReleaseMetadataState {
  const [state, setState] = useState<ReleaseMetadataState>({ status: "loading", metadata: null });

  useEffect(() => {
    let cancelled = false;

    async function loadReleaseMetadata() {
      if (typeof fetch !== "function") {
        setState({ status: "unavailable", metadata: null });
        return;
      }

      try {
        const response = await fetch("/__pharos_release.json", { cache: "no-store" });
        if (!response.ok) {
          if (!cancelled) setState({ status: "unavailable", metadata: null });
          return;
        }
        const metadata = parseReleaseMetadata(await response.json());
        if (!cancelled) {
          setState(metadata ? { status: "ready", metadata } : { status: "unavailable", metadata: null });
        }
      } catch {
        if (!cancelled) setState({ status: "unavailable", metadata: null });
      }
    }

    void loadReleaseMetadata();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
