"use client";

import Link from "next/link";
import { Bot, ExternalLink } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { PHAROSWATCHBOT_BOT_URL } from "@/lib/telegram-route-constants";
import { CLIENT_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { isTelegramReservedTargetToken } from "@shared/lib/telegram-command-vocabulary";
import { formatCoinPayload } from "@shared/lib/telegram-mini-app-payloads";

const TELEGRAM_TARGET_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

const TRACKED_BY_ID = new Map(CLIENT_TRACKED_STABLECOINS.map((coin) => [coin.id, coin]));
const SYMBOL_COUNT = new Map<string, number>();
for (const coin of CLIENT_TRACKED_STABLECOINS) {
  const key = coin.symbol.toLowerCase();
  SYMBOL_COUNT.set(key, (SYMBOL_COUNT.get(key) ?? 0) + 1);
}
const UNIQUE_ID_BY_SYMBOL = new Map<string, string>();
for (const coin of CLIENT_TRACKED_STABLECOINS) {
  const key = coin.symbol.toLowerCase();
  if ((SYMBOL_COUNT.get(key) ?? 0) === 1) {
    UNIQUE_ID_BY_SYMBOL.set(key, coin.id);
  }
}

function safeTelegramTargetToken(value: string): string | null {
  const token = value.trim();
  if (!TELEGRAM_TARGET_TOKEN_PATTERN.test(token)) return null;
  if (isTelegramReservedTargetToken(token)) return null;
  return token;
}

function normalizeTargetIds(coinIds: readonly string[]): string[] {
  return Array.from(
    new Set(coinIds.map((coinId) => safeTelegramTargetToken(coinId)).filter((token): token is string => token !== null)),
  );
}

/**
 * Resolve a stablecoin ID to its human ticker when unambiguous and command-safe,
 * falling back to the canonical ID otherwise.
 */
export function resolveTelegramTargetToken(coinId: string): string | null {
  const safeId = safeTelegramTargetToken(coinId);
  if (!safeId) return null;
  const coin = TRACKED_BY_ID.get(safeId);
  if (!coin) return safeId;
  if ((SYMBOL_COUNT.get(coin.symbol.toLowerCase()) ?? 0) === 1) {
    const safeSymbol = safeTelegramTargetToken(coin.symbol);
    if (safeSymbol) return safeSymbol;
  }
  return safeId;
}

function extractTargetIdsFromCommand(command: string): string[] {
  const trimmed = command.trim();
  const firstSpace = trimmed.search(/\s/);
  const body = trimmed.startsWith("/")
    ? (firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1))
    : trimmed;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of body.split(/[\s,]+/)) {
    const token = raw.trim();
    if (!token || isTelegramReservedTargetToken(token)) continue;
    const id = TRACKED_BY_ID.has(token)
      ? token
      : UNIQUE_ID_BY_SYMBOL.get(token.toLowerCase()) ?? null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function buildTelegramSubscribeCommandForIds(coinIds: readonly string[]): string {
  const targets = normalizeTargetIds(coinIds)
    .map((coinId) => resolveTelegramTargetToken(coinId))
    .filter((token): token is string => token !== null);
  if (targets.length === 0) return "";
  return `/subscribe dews, depeg, safety ${targets.join(", ")}`;
}

export interface TelegramSubscribeCommandProps {
  command?: string;
  coinIds?: readonly string[];
  heading?: string;
  description?: string;
  headingId?: string;
}

export function TelegramSubscribeCommand({
  command,
  coinIds,
  heading = "Follow this shortlist in PharosWatchBot",
  description = "Copies a Telegram command for DEWS, depeg, and safety alerts on the shortlisted stablecoins.",
  headingId = "selector-telegram-command-heading",
}: TelegramSubscribeCommandProps) {
  const resolvedCommand = command ?? (coinIds ? buildTelegramSubscribeCommandForIds(coinIds) : "");
  if (!resolvedCommand) return null;

  const targets = coinIds ? normalizeTargetIds(coinIds) : extractTargetIdsFromCommand(resolvedCommand);
  const singleCoinId = targets.length === 1 ? targets[0]! : null;
  const singleCoinSymbol = singleCoinId ? (TRACKED_BY_ID.get(singleCoinId)?.symbol ?? singleCoinId) : null;
  const primaryHref = singleCoinId
    ? `${PHAROSWATCHBOT_BOT_URL}?startapp=${formatCoinPayload(singleCoinId)}`
    : PHAROSWATCHBOT_BOT_URL;
  const primaryLabel = singleCoinSymbol ? `Open ${singleCoinSymbol} in Mini App` : "Open PharosWatchBot";
  const builderHref = targets.length > 0 ? `/pharoswatchbot/?coins=${targets.join(",")}#builder` : null;

  return (
    <section aria-labelledby={headingId} className="pharos-card-shell p-4 sm:p-5">
      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/60 text-muted-foreground">
              <Bot className="h-4 w-4" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="pharos-label">Telegram follow command</p>
              <h2
                id={headingId}
                className="text-sm font-semibold tracking-tight text-foreground"
              >
                {heading}
              </h2>
            </div>
          </div>
          <a
            href={primaryHref}
            target="_blank"
            rel="noopener noreferrer"
            className="pharos-focus-ring inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-full border border-foreground/60 bg-foreground px-3.5 text-sm font-medium text-background hover:bg-foreground/90"
          >
            {primaryLabel}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </div>
        <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background/85 px-3 py-2.5 shadow-[inset_0_1px_0_oklch(1_0_0_/_0.04)]">
          <span aria-hidden="true" className="font-mono text-sm font-semibold text-muted-foreground">
            ▸
          </span>
          <code className="block min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs font-medium text-foreground sm:text-sm">
            {resolvedCommand}
          </code>
          <CopyButton
            text={resolvedCommand}
            className="size-8 shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs leading-relaxed text-muted-foreground">
          <p>{description}</p>
          {builderHref ? (
            <Link
              href={builderHref}
              className="pharos-focus-ring shrink-0 rounded-sm font-medium text-brand-accent-text underline-offset-4 hover:underline"
            >
              Customize or use in a group
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
}
