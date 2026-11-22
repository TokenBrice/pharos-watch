"use client";

import { Bot, ExternalLink } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { PHAROSWATCHBOT_BOT_URL } from "@/lib/telegram-route-constants";
import { isTelegramReservedTargetToken } from "@shared/lib/telegram-command-vocabulary";

const TELEGRAM_TARGET_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

function safeTelegramTargetToken(value: string): string | null {
  const token = value.trim();
  if (!TELEGRAM_TARGET_TOKEN_PATTERN.test(token)) return null;
  if (isTelegramReservedTargetToken(token)) return null;
  return token;
}

export function buildTelegramSubscribeCommandForIds(coinIds: readonly string[]): string {
  const targets = Array.from(
    new Set(coinIds.map((coinId) => safeTelegramTargetToken(coinId)).filter((token): token is string => token !== null)),
  );
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
            href={PHAROSWATCHBOT_BOT_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="pharos-focus-ring inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-full border border-foreground/60 bg-foreground px-3.5 text-sm font-medium text-background hover:bg-foreground/90"
          >
            Open PharosWatchBot
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
        <p className="text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      </div>
    </section>
  );
}
