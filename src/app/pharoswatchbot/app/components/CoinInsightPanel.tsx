"use client";

import { ExternalLink, Info } from "lucide-react";
import { formatCoveragePayload, formatWhyPayload } from "@shared/lib/telegram-mini-app-payloads";
import { ALERT_LABELS, PHAROS_COIN_PAGE_PREFIX } from "../constants";
import { PHAROSWATCHBOT_BOT_URL } from "@/lib/telegram-route-constants";
import type { TelegramWebAppSdk } from "../telegram-sdk";
import type {
  CatalogCoin,
  CoinInsightTarget,
  SubscribedCoin,
  TelegramAlertType,
  TelegramMiniAppState,
} from "../types";
import { MiniButton } from "./MiniButton";

function formatAlertList(alertTypes: Record<TelegramAlertType, boolean>): string {
  const enabled = (Object.keys(ALERT_LABELS) as TelegramAlertType[]).filter((type) => alertTypes[type]);
  if (enabled.length === 0) return "None";
  return enabled.map((type) => ALERT_LABELS[type]).join(", ");
}

function findCoinContext(state: TelegramMiniAppState, coinId: string): { subscription: SubscribedCoin | null; catalog: CatalogCoin | null } {
  return {
    subscription: state.subscriptions.find((coin) => coin.stablecoinId === coinId) ?? null,
    catalog: state.catalog.searchableCoins.find((coin) => coin.stablecoinId === coinId) ?? null,
  };
}

export interface CoinInsightPanelProps {
  state: TelegramMiniAppState;
  target: CoinInsightTarget;
  webApp: TelegramWebAppSdk | null;
  onClose: () => void;
}

export function CoinInsightPanel({ state, target, webApp, onClose }: CoinInsightPanelProps) {
  const { subscription, catalog } = findCoinContext(state, target.coinId);
  const symbol = subscription?.symbol ?? catalog?.symbol ?? target.coinId;
  const name = subscription?.name ?? catalog?.name ?? "Unknown or no longer tracked coin";
  const botPayload = target.kind === "why" ? formatWhyPayload(target.coinId) : formatCoveragePayload(target.coinId);
  const botUrl = `${PHAROSWATCHBOT_BOT_URL}?start=${botPayload}`;
  const handleOpenTelegram = () => {
    if (webApp?.openTelegramLink) webApp.openTelegramLink(botUrl);
    else webApp?.openLink?.(botUrl);
  };
  const handleOpenPharos = () => {
    webApp?.openLink?.(`${PHAROS_COIN_PAGE_PREFIX}${target.coinId}`);
  };
  const title = target.kind === "why" ? `Why ${symbol}` : `Coverage ${symbol}`;
  const isKnown = subscription != null || catalog != null;
  const alertSummary = subscription
    ? formatAlertList({
        ...subscription.alertTypes,
        freeze: Boolean((subscription.alertTypes as Partial<Record<TelegramAlertType, boolean>>).freeze),
      })
    : "Not in your explicit watchlist";

  return (
    <section className="rounded-2xl border border-[color:var(--mini-accent-border)] bg-[color:var(--mini-accent-fill)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="pharos-kicker">In-app {target.kind}</p>
          <h2 className="mt-1 truncate text-base font-semibold text-foreground">{title}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{name}</p>
        </div>
        <MiniButton ariaLabel={`Close ${title}`} variant="secondary" onClick={onClose}>
          Close
        </MiniButton>
      </div>

      {target.kind === "why" ? (
        <div className="mt-4 grid gap-2 text-sm">
          <div className="rounded-lg border border-border/55 bg-background/55 p-3">
            <p className="text-xs font-semibold uppercase text-muted-foreground">Watch context</p>
            <p className="mt-1 text-foreground">{alertSummary}</p>
          </div>
          <div className="rounded-lg border border-border/55 bg-background/55 p-3">
            <p className="text-xs font-semibold uppercase text-muted-foreground">Safety explainer</p>
            <p className="mt-1 text-muted-foreground">Full Safety Score notes are still delivered by the bot reply.</p>
          </div>
        </div>
      ) : (
        <div className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
          <div className="rounded-lg border border-border/55 bg-background/55 p-3">
            <p className="text-xs font-semibold uppercase text-muted-foreground">Registry</p>
            <p className="mt-1 text-foreground">{isKnown ? "Tracked by Pharos" : "No current catalog match"}</p>
          </div>
          <div className="rounded-lg border border-border/55 bg-background/55 p-3">
            <p className="text-xs font-semibold uppercase text-muted-foreground">Peg</p>
            <p className="mt-1 text-foreground">{catalog?.peg ?? "Not available in this launch"}</p>
          </div>
          <div className="rounded-lg border border-border/55 bg-background/55 p-3">
            <p className="text-xs font-semibold uppercase text-muted-foreground">Status</p>
            <p className="mt-1 text-foreground">{catalog?.status ?? "Not available in this launch"}</p>
          </div>
          <div className="rounded-lg border border-border/55 bg-background/55 p-3">
            <p className="text-xs font-semibold uppercase text-muted-foreground">Alert coverage</p>
            <p className="mt-1 text-foreground">{alertSummary}</p>
          </div>
        </div>
      )}

      {!isKnown ? (
        <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-muted-foreground">
          This launch target is not in the current Mini App catalog. No settings were changed.
        </p>
      ) : null}

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <MiniButton variant="secondary" disabled={!webApp} onClick={handleOpenTelegram}>
          <Info className="h-4 w-4" aria-hidden="true" /> Open bot reply
        </MiniButton>
        <MiniButton variant="secondary" disabled={!webApp} onClick={handleOpenPharos}>
          <ExternalLink className="h-4 w-4" aria-hidden="true" /> View on Pharos
        </MiniButton>
      </div>
    </section>
  );
}
