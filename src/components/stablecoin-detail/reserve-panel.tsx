"use client";

import { RefreshCw } from "lucide-react";
import { ReserveTreemap } from "@/components/reserve-treemap";
import type { ReserveResult } from "@shared/lib/reserve-templates";
import type { StablecoinMeta } from "@shared/types";
import {
  buildReserveCompositionNote,
  buildReserveFetchNotice,
  buildReserveFootnoteModel,
  buildReserveProvenanceNotice,
  buildReserveSyncNotice,
  type ReserveNoticeModel,
} from "./reserve-presentation";

export interface ReservePanelProps {
  coin: StablecoinMeta;
  reserves: ReserveResult | null;
  reserveFetchError: unknown | null;
  onRetry?: () => Promise<unknown> | void;
  isFetching?: boolean;
}

function ReserveStatusNotice({
  notice,
  onRetry,
  isFetching = false,
}: {
  notice: ReserveNoticeModel;
  onRetry?: () => Promise<unknown> | void;
  isFetching?: boolean;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy={isFetching || undefined}
      className={`rounded-lg border px-4 py-3 text-sm leading-relaxed ${notice.toneClass}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="font-medium">{notice.title}</p>
          <p className="mt-1">{notice.message}</p>
        </div>
        {onRetry ? (
          <button
            type="button"
            onClick={() => { void onRetry(); }}
            disabled={isFetching}
            className="pharos-focus-ring inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-current/20 px-2.5 py-1 text-xs font-medium transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-70 dark:hover:bg-black/10"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} aria-hidden="true" />
            {isFetching ? "Retrying" : "Retry"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function ReservePanel({
  coin,
  reserves,
  reserveFetchError,
  onRetry,
  isFetching = false,
}: ReservePanelProps) {
  const isLiveEnabled = !!coin.liveReservesConfig;
  const reserveFetchNotice = reserveFetchError
    ? buildReserveFetchNotice(reserveFetchError, reserves)
    : null;
  const reserveCompositionNote = buildReserveCompositionNote(reserves);
  const reserveProvenanceNotice = buildReserveProvenanceNotice(reserves);
  const reserveSyncNotice = buildReserveSyncNotice(reserves);
  const reserveFootnote = reserves
    ? buildReserveFootnoteModel(reserves, isLiveEnabled, coin.flags.backing.replace("-", " "))
    : null;

  if (!reserves && !reserveFetchError) {
    return null;
  }

  return (
    <div className="flex h-full flex-col gap-6">
      {reserveFetchNotice ? (
        <ReserveStatusNotice notice={reserveFetchNotice} onRetry={onRetry} isFetching={isFetching} />
      ) : null}
      {reserves ? (
        <section id="reserves" aria-label="Reserve composition" className="flex min-w-0 flex-1 flex-col">
          <ReserveTreemap
            reserves={reserves.reserves}
            badge={reserves.displayBadge}
          />
          {reserveFootnote ? (
            <div className="mt-1 flex min-w-0 flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-xs text-muted-foreground">
              {reserveFootnote.text ? <span>{reserveFootnote.text}</span> : null}
              {reserveFootnote.references.map((reference) => (
                <span key={`${reference.label}:${reference.url}`}>
                  <span aria-hidden>·</span>{" "}
                  <a
                    href={reference.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2 transition-colors hover:text-foreground"
                  >
                    {reference.label}
                  </a>
                </span>
              ))}
            </div>
          ) : null}
          {reserveCompositionNote ? (
            <div className="mt-2 text-center text-xs text-muted-foreground">{reserveCompositionNote}</div>
          ) : null}
          {reserveProvenanceNotice ? (
            /* Mono uppercase provenance footnote (Figma coin template) —
               pinned to the column bottom, replacing the former bordered
               notice block. */
            <p className="mt-auto border-t border-border/40 pt-3 font-mono text-[10px] uppercase leading-relaxed tracking-[0.14em] text-muted-foreground">
              {reserveProvenanceNotice.title} — {reserveProvenanceNotice.message}
            </p>
          ) : null}
          {reserveSyncNotice ? (
            <div
              role="status"
              aria-live="polite"
              className={`mt-2 rounded-lg border px-4 py-3 text-sm leading-relaxed ${reserveSyncNotice.toneClass}`}
            >
              <p className="font-medium">{reserveSyncNotice.title}</p>
              <div className="mt-1 space-y-1">
                {reserveSyncNotice.rows.map((row) => (
                  <p key={row}>{row}</p>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
