"use client";

import Link from "next/link";
import { Bell, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TELEGRAM_BOT_URL } from "@shared/lib/telegram-bot-registration";

const POPOVER_LINK_CLASS =
  "pharos-focus-ring inline-flex min-h-8 items-center gap-1 rounded-sm underline decoration-dashed underline-offset-2 transition-colors hover:text-foreground";

/**
 * The pre-launch dossier's header action, sized like `AlertsHeaderLink`. The
 * exact per-asset bot command is part of the trigger's accessible name (so it
 * is in the server HTML) and opens with a copy control in the popover. The
 * command uses the canonical Pharos ID, never the ticker.
 */
export function PreLaunchAlertAction({ coinId, symbol }: { coinId: string; symbol: string }) {
  const command = `/subscribe launch ${coinId}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 rounded-full px-4 lg:min-h-8 lg:rounded-md"
          aria-label={`Launch alert: send ${command} to @PharosWatchBot`}
        >
          <Bell aria-hidden="true" />
          <span>Launch alert</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] space-y-3 p-4 text-xs leading-relaxed">
        <p className="text-sm font-semibold text-foreground">Telegram alert when {symbol} goes live</p>
        <p className="text-muted-foreground">
          Send this to @PharosWatchBot for one message when Pharos starts tracking {symbol}. It names the exact Pharos ID,
          so an ambiguous ticker cannot misfire.
        </p>
        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 py-1 pl-3 pr-1">
          <code tabIndex={0} className="pharos-focus-ring min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-sm font-mono text-xs text-foreground">
            {command}
          </code>
          <CopyButton text={command} className="shrink-0" />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
          <a href={TELEGRAM_BOT_URL} target="_blank" rel="noopener noreferrer" className={POPOVER_LINK_CLASS}>
            Open @PharosWatchBot
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
          <Link href="/pharoswatchbot/#getting-started" className={POPOVER_LINK_CLASS}>
            All alert options
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
