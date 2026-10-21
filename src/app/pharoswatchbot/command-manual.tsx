import { ChevronRight } from "lucide-react";
import { TELEGRAM_COMMAND_GROUPS, TELEGRAM_COMMAND_REFERENCE_TIPS } from "./telegram-content";

/**
 * Compact command card: every registered command variant with its one-line
 * help, grouped as the menu and typed-only commands. Rows derive from the
 * BotFather registration source, so the page cannot list a retired command.
 */
export function CommandManual() {
  return (
    <div>
      <div className="grid gap-6 lg:grid-cols-2 lg:gap-10" aria-label="PharosWatchBot command reference">
        {TELEGRAM_COMMAND_GROUPS.map((group, index) => {
          const headingId = `command-group-${group.label.toLowerCase().replaceAll(" ", "-")}`;
          const rows = (
            <dl className="mt-2 divide-y divide-border/45 border-y border-border/55">
              {group.commands.map((cmd) => (
                <div key={cmd.command} className="grid min-w-0 gap-0.5 py-1.5 sm:py-2 sm:grid-cols-[minmax(11rem,auto)_minmax(0,1fr)] sm:gap-4">
                  <dt className="min-w-0">
                    <code className="font-mono text-xs font-semibold text-foreground [overflow-wrap:anywhere]">
                      {cmd.command}
                    </code>
                  </dt>
                  <dd className="min-w-0 text-xs leading-relaxed text-muted-foreground">{cmd.description}</dd>
                </div>
              ))}
            </dl>
          );
          const heading = (
            <h3 id={headingId} className="inline font-mono text-xs font-semibold uppercase text-muted-foreground">
              {group.label}
            </h3>
          );
          // The menu group stays open; the typed-only extras collapse.
          return index === 0 ? (
            <section key={group.label} aria-labelledby={headingId}>
              {heading}
              {rows}
            </section>
          ) : (
            <details key={group.label} className="group" aria-labelledby={headingId}>
              <summary className="pharos-focus-ring flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-sm text-muted-foreground [&::-webkit-details-marker]:hidden">
                <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
                {heading}
                <span className="text-xs">({group.commands.length})</span>
              </summary>
              {rows}
            </details>
          );
        })}
      </div>
      <ul className="mt-5 space-y-1 text-xs leading-relaxed text-muted-foreground">
        {TELEGRAM_COMMAND_REFERENCE_TIPS.map((tip) => (
          <li key={tip}>{tip}</li>
        ))}
      </ul>
    </div>
  );
}
