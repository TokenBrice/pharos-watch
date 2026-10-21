"use client";

import { Activity, Layers, Search, Send, TrendingDown } from "lucide-react";
import { RECOMMENDED_OPERATION } from "../constants";
import { usePrimaryAction } from "../primary-action";
import type { MiniAppScreen } from "../use-mini-app-view";
import type { MiniAppScreenProps } from "../types";
import { ListRow, ListSection } from "./List";

const ICON_CLASS = "h-4 w-4 text-[color:var(--telegram-link,var(--mini-accent))]";

export interface SetupScreenProps extends MiniAppScreenProps {
  push: (screen: MiniAppScreen) => void;
  onSendSample?: () => void;
}

/** First run, and the `startapp=setup` target: one recommended choice, with ways to pick instead. */
export function SetupScreen({ canEdit, busy, pendingOperation, onMutate, push, onSendSample }: SetupScreenProps) {
  const pending = pendingOperation?.kind === "recommended-setup";
  usePrimaryAction(canEdit ? {
    text: "Use recommended setup",
    progress: pending,
    onClick: () => {
      if (!busy) onMutate(RECOMMENDED_OPERATION);
    },
  } : null);

  return (
    <>
      <header className="px-1 pt-2">
        <h1 className="text-2xl font-semibold tracking-tight text-balance text-foreground">Get stablecoin alerts in this chat</h1>
        <p className="mt-2 text-sm leading-relaxed text-pretty text-muted-foreground">
          Recommended: early warnings and depeg alerts for the 25 largest USD stablecoins. You can change it any time.
        </p>
      </header>

      <ListSection title="What you'll get" className="mt-5">
        <ListRow
          leading={<Activity className={ICON_CLASS} aria-hidden="true" />}
          title="Early warning"
          subtitle="When stress on a coin rises on the DEWS radar"
        />
        <ListRow
          leading={<TrendingDown className={ICON_CLASS} aria-hidden="true" />}
          title="Depeg"
          subtitle="When a coin's price moves away from its peg"
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

      {onSendSample ? (
        <ListSection>
          <ListRow
            leading={<Send className={ICON_CLASS} aria-hidden="true" />}
            title="Send a sample alert to this chat"
            tone="accent"
            onClick={onSendSample}
          />
        </ListSection>
      ) : null}
    </>
  );
}
