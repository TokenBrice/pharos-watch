"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import {
  TELEGRAM_COMMAND_COUNT,
  TELEGRAM_COMMAND_GROUPS,
  TELEGRAM_COMMAND_REFERENCE_TIPS,
  TELEGRAM_PARAM_LEGEND,
} from "./telegram-content";

/**
 * The full command reference, un-collapsed and filterable. Zero-dependency
 * filtering across command, description, and example text.
 */
export function CommandManual() {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();

  const filteredGroups = useMemo(() => {
    if (!normalized) return TELEGRAM_COMMAND_GROUPS;
    return TELEGRAM_COMMAND_GROUPS.map((group) => ({
      ...group,
      commands: group.commands.filter((cmd) => {
        return (
          cmd.command.toLowerCase().includes(normalized) ||
          cmd.description.toLowerCase().includes(normalized) ||
          (cmd.example ?? "").toLowerCase().includes(normalized)
        );
      }),
    })).filter((group) => group.commands.length > 0);
  }, [normalized]);

  const visibleCount = filteredGroups.reduce((sum, group) => sum + group.commands.length, 0);

  return (
    <div>
      <div className="relative max-w-md">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <label htmlFor="command-filter" className="sr-only">
          Filter bot commands
        </label>
        <input
          id="command-filter"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder='Filter commands — try "mute", "recap", "usdt"'
          className="pharos-focus-ring h-11 w-full rounded-lg border border-border/60 bg-background/60 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground/70"
        />
      </div>
      <p aria-live="polite" className="mt-2 text-xs text-muted-foreground">
        {normalized
          ? `${visibleCount} of ${TELEGRAM_COMMAND_COUNT} commands match`
          : `${TELEGRAM_COMMAND_COUNT} commands in ${TELEGRAM_COMMAND_GROUPS.length} groups`}
      </p>

      {filteredGroups.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-border/60 px-4 py-6 text-sm text-muted-foreground">
          No commands match &ldquo;{query}&rdquo;. Try a command verb like <code>/set</code>, a coin ticker, or a
          setting name.
        </p>
      ) : (
        <div className="mt-6 space-y-8" aria-label="PharosWatchBot command reference">
          {filteredGroups.map((group) => (
            <section
              key={group.label}
              aria-labelledby={`command-group-${group.label.toLowerCase().replaceAll(" ", "-")}`}
            >
              <h3
                id={`command-group-${group.label.toLowerCase().replaceAll(" ", "-")}`}
                className="font-mono text-xs font-semibold uppercase text-muted-foreground"
              >
                {group.label}
              </h3>
              <dl className="mt-2 divide-y divide-border/45 border-y border-border/55">
                {group.commands.map((cmd) => (
                  <div
                    key={cmd.command}
                    className="grid min-w-0 gap-2 py-3 sm:grid-cols-[minmax(12rem,0.9fr)_minmax(0,1.4fr)] sm:gap-5"
                  >
                    <dt className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1 rounded-lg bg-muted px-1 py-0.5">
                        <code className="min-w-0 flex-1 whitespace-pre-wrap px-1 font-mono text-xs text-foreground [overflow-wrap:anywhere]">
                          {cmd.command}
                        </code>
                        <CopyButton
                          text={cmd.command}
                          className="size-11 shrink-0 text-muted-foreground hover:bg-background/70 hover:text-foreground"
                        />
                      </div>
                    </dt>
                    <dd className="min-w-0 text-xs leading-relaxed text-muted-foreground">
                      {cmd.description}
                      {cmd.example ? (
                        <span className="mt-1.5 block">
                          <span className="sr-only">Example: </span>
                          <code className="whitespace-pre-wrap font-mono text-xs text-foreground [overflow-wrap:anywhere]">
                            {cmd.example}
                          </code>
                        </span>
                      ) : null}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      )}

      <div className="mt-10 grid gap-10 lg:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Parameter syntax</h3>
          <dl className="mt-3 grid gap-x-8 gap-y-2">
            {TELEGRAM_PARAM_LEGEND.map((entry) => (
              <div key={entry.token} className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] items-baseline gap-3">
                <dt className="font-mono text-xs font-semibold text-foreground [overflow-wrap:anywhere]">
                  {entry.token}
                </dt>
                <dd className="text-xs leading-relaxed text-muted-foreground">{entry.meaning}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground">Command tips</h3>
          <ul className="mt-3 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
            {TELEGRAM_COMMAND_REFERENCE_TIPS.map((tip) => (
              <li key={tip}>{tip}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
