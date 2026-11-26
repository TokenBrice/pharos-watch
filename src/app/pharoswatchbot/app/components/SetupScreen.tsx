"use client";

import { Activity, Layers, Search, TrendingDown } from "lucide-react";
import { isTelegramBlockedFailureClass } from "@shared/lib/telegram-delivery-policy";
import { ALERT_DESCRIPTIONS, ALERT_LABELS, DAILY_LIVE_ALERT_CAP, RECOMMENDED_OPERATION } from "../constants";
import { usePrimaryAction } from "../primary-action";
import type { MiniAppScreen } from "../use-mini-app-view";
import type { MiniAppScreenProps } from "../types";
import { ListRow, ListSection } from "./List";

const ICON_CLASS = "h-4 w-4 text-[color:var(--telegram-link,var(--mini-accent))]";

export interface SetupScreenProps extends MiniAppScreenProps {
  push: (screen: MiniAppScreen) => void;
}

/** First run, and retained empty subscribers: one recommended choice, with ways to pick instead. */
export function SetupScreen({ state, canEdit, busy, pendingOperation, onMutate, push }: SetupScreenProps) {
  const pending = pendingOperation?.kind === "recommended-setup";
  const retainedBlocked = state.subscriber.exists && isTelegramBlockedFailureClass(state.health.recentFailureClass);

  usePrimaryAction(canEdit ? {
    kind: "setup",
    text: "Follow USD Top 25",
    progress: pending,
    onClick: () => {
      if (!busy) onMutate(RECOMMENDED_OPERATION);
    },
  } : null);

  return (
    <>
      {retainedBlocked ? (
        <section role="alert" className="mb-5 flex gap-3 rounded-xl bg-[var(--mini-card)] px-4 py-3">
          <span aria-hidden="true" className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-state-danger-solid" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-foreground">Telegram stopped delivering alerts</h2>
            <p className="mt-0.5 text-sm leading-snug text-muted-foreground">
              Open the chat and tap Start (or send /status) to resume delivery.
            </p>
          </div>
        </section>
      ) : null}

      <header className="px-1 pt-2">
        <h1 tabIndex={-1} className="outline-none text-2xl font-semibold tracking-tight text-balance text-foreground">
          Get stablecoin alerts in this chat
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-pretty text-muted-foreground">
          Early warnings and depeg alerts for the 25 largest USD stablecoins by market cap.
        </p>
      </header>

      <ListSection
        title="What you'll get"
        className="mt-5"
        footer={`At most ${DAILY_LIVE_ALERT_CAP} live alerts a day outside depegs.`}
      >
        <ListRow
          leading={<Activity className={ICON_CLASS} aria-hidden="true" />}
          title={ALERT_LABELS.dews}
          subtitle={ALERT_DESCRIPTIONS.dews}
        />
        <ListRow
          leading={<TrendingDown className={ICON_CLASS} aria-hidden="true" />}
          title={ALERT_LABELS.depeg}
          subtitle={ALERT_DESCRIPTIONS.depeg}
        />
      </ListSection>

      {canEdit ? (
        <ListSection title="Or choose yourself">
          <ListRow
            leading={<Search className={ICON_CLASS} aria-hidden="true" />}
            title="Pick coins"
            chevron
            onClick={() => push({ name: "add-coins" })}
          />
          <ListRow
            leading={<Layers className={ICON_CLASS} aria-hidden="true" />}
            title="Follow a preset"
            subtitle="Top USD, non-USD, euro, gold, or by size"
            chevron
            onClick={() => push({ name: "add-group" })}
          />
        </ListSection>
      ) : null}

      {state.subscriber.exists ? (
        <ListSection>
          <ListRow title="Settings" chevron onClick={() => push({ name: "settings" })} />
        </ListSection>
      ) : null}
    </>
  );
}
