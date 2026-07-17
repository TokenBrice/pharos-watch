import Link from "next/link";
import { LockKeyhole, Radio, ShieldCheck } from "lucide-react";
import { FaqSection } from "@/components/faq-section";
import { CopyButton } from "@/components/copy-button";
import {
  PENDING_TTL_SEC,
  TELEGRAM_ALERT_TTL_SEC,
  TELEGRAM_DISPATCH_INTERVAL_SEC,
} from "@shared/lib/telegram-delivery-policy";
import { CommandManual } from "./command-manual";
import { RECOMMENDED_SETUPS, TELEGRAM_FAQ } from "./telegram-content";

const PROSE_LINK_CLASS =
  "pharos-focus-ring rounded-sm underline underline-offset-4 transition-colors hover:text-foreground";

// Reliability copy derives from the shared delivery policy so the public
// contract cannot drift from production TTL/cadence constants (TGB-028).
function formatPolicyDuration(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

const DISPATCH_CADENCE_LABEL = formatPolicyDuration(TELEGRAM_DISPATCH_INTERVAL_SEC);
const RISK_ALERT_TTL_LABEL = formatPolicyDuration(PENDING_TTL_SEC);
const LAUNCH_ALERT_TTL_LABEL = formatPolicyDuration(TELEGRAM_ALERT_TTL_SEC.launch);
const ADMIN_ALERT_TTL_LABEL = formatPolicyDuration(TELEGRAM_ALERT_TTL_SEC.adminBroadcast);

/**
 * Act VI — the reference shelf. Everything, in writing: the full command
 * reference (un-collapsed, filterable), the reliability contract in plain
 * sight, and the FAQ. Reference content after conversion, not hedging
 * mid-funnel.
 */
export function FieldManual() {
  return (
    <section id="manual" className="pharos-night-dawn scroll-mt-20" aria-labelledby="manual-title">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:py-24 lg:px-5 xl:px-9">
        <div className="max-w-2xl">
          <h2 id="manual-title" className="pharos-display text-foreground">
            Commands, limits, and answers
          </h2>
          <p className="pharos-lead mt-3">
            Everything, in writing: every command, every bound, every privacy term.
          </p>
        </div>

        <div className="mt-10">
          <CommandManual />
        </div>

        <div className="mt-14">
          <h3 className="text-sm font-semibold text-foreground">Other starter setups</h3>
          <div className="mt-3 grid gap-6 sm:grid-cols-2">
            {RECOMMENDED_SETUPS.slice(1).map((setup) => (
              <div key={setup.command} className="border-t border-border/55 pt-4">
                <p className="text-sm font-semibold text-foreground">{setup.title}</p>
                <div className="mt-2 flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background/70 px-2 py-1.5">
                  <code className="block min-w-0 flex-1 whitespace-pre-wrap px-1 font-mono text-xs text-foreground [overflow-wrap:anywhere]">
                    {setup.command}
                  </code>
                  <CopyButton
                    text={setup.command}
                    className="size-11 shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground"
                  />
                </div>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{setup.description}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-14" aria-labelledby="reliability-title">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            </span>
            <div className="max-w-2xl">
              <h3 id="reliability-title" className="text-lg font-semibold text-foreground">
                What Pharos promises — and what it does not
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Alerts are a bounded notification service, not a guaranteed emergency pager. Each message links back
                to Pharos so you can inspect the underlying signal.
              </p>
            </div>
          </div>
          <dl className="mt-6 grid gap-x-8 sm:grid-cols-3">
            <div className="border-t border-border/55 py-4">
              <dt className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Radio className="h-4 w-4" aria-hidden="true" /> Source cadence
              </dt>
              <dd className="mt-2 text-xs leading-relaxed text-muted-foreground">
                The dispatcher runs every {DISPATCH_CADENCE_LABEL}. Safety follows the live report-card publish path;
                reserve drift follows the four-hour live-reserve producer and only fires for supported live-reserve
                coins.
              </dd>
            </div>
            <div className="border-t border-border/55 py-4">
              <dt className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <ShieldCheck className="h-4 w-4" aria-hidden="true" /> Bounded delivery
              </dt>
              <dd className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Eligible alerts can send immediately or enter a retry queue. Risk alerts expire after{" "}
                {RISK_ALERT_TTL_LABEL}; launch alerts after {LAUNCH_ALERT_TTL_LABEL} and admin broadcasts after{" "}
                {ADMIN_ALERT_TTL_LABEL}. Terminal and ambiguous outcomes stay visible to operators rather than being
                silently replayed.
              </dd>
            </div>
            <div className="border-t border-border/55 py-4">
              <dt className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <LockKeyhole className="h-4 w-4" aria-hidden="true" /> Privacy
              </dt>
              <dd className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Pharos stores your chat ID, optional username, follows, alert settings, quiet hours, snooze state, and
                short-lived command or queue metadata. Use <code>/forget</code> in a private chat for immediate
                deletion; inactive unsubscribed chats are pruned after 180 days.
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            Adoption metrics above are aggregate counts; small daily changes are hidden to avoid identifying
            individual chats. Read the full{" "}
            <Link href="/privacy/" className={PROSE_LINK_CLASS}>
              privacy policy
            </Link>
            .
          </p>
        </div>

        <div className="mt-14">
          <FaqSection items={TELEGRAM_FAQ} title="Frequently asked questions" includeJsonLd />
        </div>
      </div>
    </section>
  );
}
