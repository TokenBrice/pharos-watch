"use client";

import Link from "next/link";
import { Bot, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TELEGRAM_BOT_URL } from "@shared/lib/telegram-bot-registration";

export function PreviewState({ previewName }: { previewName: string | null }) {
  return (
    <section className="mx-auto flex min-h-[100svh] max-w-lg flex-col justify-center px-4 py-8">
      <section className="rounded-2xl border border-border/70 bg-card/90 p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300">
            <Bot className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-foreground">PharosWatchBot app preview</h1>
            <p className="text-xs text-muted-foreground">Read-only browser mode</p>
          </div>
        </div>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          {previewName ? `${previewName}, open this page inside Telegram to manage alerts.` : "Open this page from the Telegram bot menu to load your alert settings."}
        </p>
        <div className="mt-5 grid gap-2">
          <Button asChild className="gap-2">
            <a href={TELEGRAM_BOT_URL} target="_blank" rel="noopener noreferrer">Open PharosWatchBot <ExternalLink className="h-4 w-4" aria-hidden="true" /></a>
          </Button>
          <Button asChild variant="outline"><Link href="/pharoswatchbot/">View setup guide</Link></Button>
        </div>
      </section>
    </section>
  );
}
