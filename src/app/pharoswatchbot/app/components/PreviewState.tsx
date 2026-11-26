"use client";

import Image from "next/image";
import Link from "next/link";
import { Bot, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TELEGRAM_BOT_URL } from "@shared/lib/telegram-bot-registration";
import { parseMiniAppPayload } from "@shared/lib/telegram-mini-app-payloads";

const PREVIEW_HIGHLIGHTS = [
  "Follow USD Top 25 or pick specific coins",
  "Tune early-warning (DEWS) and depeg thresholds",
  "Set timezone-aware quiet hours and pause delivery",
] as const;

export function PreviewState({
  previewName,
  startParam,
}: {
  previewName: string | null;
  startParam?: string | null;
}) {
  const validStartParam = startParam && parseMiniAppPayload(startParam)
    ? startParam.trim().toLowerCase()
    : null;
  const openBotHref = validStartParam
    ? `${TELEGRAM_BOT_URL}?startapp=${encodeURIComponent(validStartParam)}`
    : `${TELEGRAM_BOT_URL}?startapp=home`;

  return (
    <section className="pharos-mini-app flex min-h-[100svh] flex-col justify-center bg-[var(--mini-panel)] px-4 py-8 text-[var(--telegram-text,var(--foreground))]">
      <section className="mx-auto w-full max-w-lg rounded-2xl bg-[var(--mini-card)] p-5">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--mini-accent-fill)] text-[color:var(--mini-accent)]">
            <Bot className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h1 tabIndex={-1} className="outline-none text-lg font-semibold tracking-tight text-foreground">
              PharosWatchBot app preview
            </h1>
            <p className="text-xs text-muted-foreground">Read-only browser mode</p>
          </div>
        </div>

        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          {previewName
            ? `${previewName}, open this page inside Telegram to manage alerts.`
            : "Open this page from the Telegram bot menu to load your alert settings."}
        </p>

        <div className="mt-4 overflow-hidden rounded-xl border border-border/50 bg-[var(--mini-panel)]">
          <Image
            src="/featured/telegram-mini-app/home.jpg"
            alt="PharosWatchBot Mini App home screen preview"
            width={549}
            height={1280}
            className="mx-auto h-48 w-full object-cover object-top"
          />
        </div>

        <ul className="mt-4 space-y-1.5 text-sm text-muted-foreground">
          {PREVIEW_HIGHLIGHTS.map((item) => (
            <li key={item} className="flex items-start gap-2">
              <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--mini-accent)]" />
              <span>{item}</span>
            </li>
          ))}
        </ul>

        <div className="mt-5 grid gap-2">
          <Button asChild className="min-h-11 gap-2 rounded-xl">
            <a href={openBotHref} target="_blank" rel="noopener noreferrer">
              Open PharosWatchBot <ExternalLink className="h-4 w-4" aria-hidden="true" />
            </a>
          </Button>
          <Button asChild variant="outline" className="min-h-11 rounded-xl">
            <Link href="/pharoswatchbot/">View setup guide</Link>
          </Button>
        </div>
      </section>
    </section>
  );
}
