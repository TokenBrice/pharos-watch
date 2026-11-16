"use client";

import { AlertTriangle, ArrowDown, Info } from "lucide-react";
import type { CoinNotice } from "@shared/types/stablecoin-meta-primitives";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import { cn } from "@/lib/utils";

interface HolderAlert {
  key: string;
  tone: "warning" | "info";
  title: string;
  message: string;
  href?: string;
  hrefLabel?: string;
}

const TONE = {
  warning: { surface: SEVERITY_TONE_CLASS.watch.banner, icon: "text-state-warn", Icon: AlertTriangle, kicker: "Action may be needed" },
  info: { surface: SEVERITY_TONE_CLASS.info.banner, icon: "text-state-info", Icon: Info, kicker: "Notice" },
} as const;

/**
 * Holder alerts: what a holder may need to act on, directly under the hero
 * instead of mid-page. Danger notices keep their own banner
 * (`ExploitNoticeBanner`); this strip carries the coin's current warning and
 * info notices (a chain sunset, a minting pause, a collateral caveat) and a
 * live depeg. Notices are curated, current-state records, so each one stays
 * visible rather than folded.
 */
export function HolderAlerts({
  notices,
  activeDepeg = false,
  symbol,
}: {
  notices?: readonly CoinNotice[] | null;
  activeDepeg?: boolean;
  symbol: string;
}) {
  const alerts: HolderAlert[] = [];
  if (activeDepeg) {
    alerts.push({
      key: "active-depeg",
      tone: "warning",
      title: `${symbol} is trading off its peg`,
      message: "A depeg is in progress. The Depeg Duration Resolver below estimates how long comparable events lasted.",
      href: "#overview",
      hrefLabel: "See the live depeg",
    });
  }
  for (const notice of notices ?? []) {
    if (notice.type === "danger") continue;
    alerts.push({ key: `${notice.type}-${notice.title}`, tone: notice.type, title: notice.title, message: notice.message });
  }
  if (alerts.length === 0) return null;

  return (
    <section aria-label={`Alerts for ${symbol} holders`} className="space-y-2" data-holder-alerts>
      {alerts.map((alert) => {
        const tone = TONE[alert.tone];
        return (
          <div
            key={alert.key}
            className={cn("flex items-start gap-3 rounded-lg border px-4 py-3", tone.surface)}
          >
            <tone.Icon aria-hidden="true" className={cn("mt-0.5 h-4 w-4 shrink-0", tone.icon)} />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-sm font-semibold text-foreground">{alert.title}</span>
                <span className={cn("text-2xs font-medium", tone.icon)}>{tone.kicker}</span>
              </p>
              <p className="mt-1 text-pretty text-sm leading-relaxed text-foreground/80">{alert.message}</p>
              {alert.href ? (
                <a
                  href={alert.href}
                  className="pharos-focus-ring mt-1.5 inline-flex items-center gap-1 rounded-sm text-sm font-medium text-foreground underline-offset-2 hover:underline"
                >
                  {alert.hrefLabel}
                  <ArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
                </a>
              ) : null}
            </div>
          </div>
        );
      })}
    </section>
  );
}
