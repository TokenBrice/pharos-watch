"use client";

import { useEffect, useState } from "react";
import { RequestSequence, isRequestCancellation, requestJson } from "@/lib/request";

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

export function useReleaseMetadata(enabled = true): ReleaseMetadataState {
  const [state, setState] = useState<ReleaseMetadataState>({ status: "loading", metadata: null });

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const requests = new RequestSequence();

    async function loadReleaseMetadata() {
      if (typeof fetch !== "function") {
        setState({ status: "unavailable", metadata: null });
        return;
      }

      try {
        const payload = await requests.run((signal) =>
          requestJson<unknown>("/__pharos_release.json", {
            signal,
            timeoutMs: 5_000,
            init: { cache: "no-store" },
          }),
        );
        const metadata = parseReleaseMetadata(payload);
        setState(metadata ? { status: "ready", metadata } : { status: "unavailable", metadata: null });
      } catch (error) {
        if (!isRequestCancellation(error)) setState({ status: "unavailable", metadata: null });
      }
    }

    void loadReleaseMetadata();

    return () => {
      requests.cancel();
    };
  }, [enabled]);

  return enabled ? state : { status: "unavailable", metadata: null };
}
