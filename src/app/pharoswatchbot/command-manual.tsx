"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";
import { copyText } from "@/lib/clipboard";
import {
  TELEGRAM_BOT_USERNAME,
  TELEGRAM_COMMAND_REFERENCE,
  type TelegramCommandName,
} from "@shared/lib/telegram-bot-registration";
import { TELEGRAM_COMMAND_GROUPS, TELEGRAM_COMMAND_REFERENCE_TIPS, type TelegramCommandRow } from "./telegram-content";

type CommandChatMode = "private" | "group";

const PRIVATE_ONLY_COMMANDS = new Set<TelegramCommandName>(["start", "forget"]);

function commandBaseName(syntax: string): TelegramCommandName | null {
  const match = syntax.match(/^\/([a-z]+)/);
  if (!match) return null;
  const name = match[1] as TelegramCommandName;
  return Object.prototype.hasOwnProperty.call(TELEGRAM_COMMAND_REFERENCE, name) ? name : null;
}

function formatForChatMode(text: string, mode: CommandChatMode): string {
  if (mode === "private") return text;
  return text.replace(/^\/([a-z]+)/, `/$1@${TELEGRAM_BOT_USERNAME}`);
}

function resolveCopyText(cmd: TelegramCommandRow, mode: CommandChatMode): string {
  return formatForChatMode(cmd.example ?? cmd.command, mode);
}

const ALL_COMMAND_ROWS: readonly (TelegramCommandRow & { name: TelegramCommandName | null })[] =
  TELEGRAM_COMMAND_GROUPS.flatMap((group) =>
    group.commands.map((cmd) => ({ ...cmd, name: commandBaseName(cmd.command) })),
  );

/**
 * Compact command card: every registered command variant with its one-line
 * help, grouped as the menu and typed-only commands. Rows derive from the
 * BotFather registration source, so the page cannot list a retired command.
 */
export function CommandManual() {
  const [chatMode, setChatMode] = useState<CommandChatMode>("private");
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const handleCopy = useCallback(async (text: string, key: string) => {
    const result = await copyText(text);
    if (!result.ok) return;
    if (copyTimer.current) clearTimeout(copyTimer.current);
    setCopiedCommand(key);
    copyTimer.current = setTimeout(() => {
      setCopiedCommand(null);
      copyTimer.current = null;
    }, 2000);
  }, []);

  const groups = useMemo(() => {
    if (chatMode === "private") return TELEGRAM_COMMAND_GROUPS;
    // In groups, BotFather only registers `menu: "all"` commands in the slash menu;
    // `menu: "private"` commands that still work in groups (such as /pause) stay typed-only.
    const menuCommands: TelegramCommandRow[] = [];
    const typedCommands: TelegramCommandRow[] = [];
    for (const row of ALL_COMMAND_ROWS) {
      if (row.name !== null && PRIVATE_ONLY_COMMANDS.has(row.name)) continue;
      if (row.name !== null && TELEGRAM_COMMAND_REFERENCE[row.name].menu === "all") {
        menuCommands.push(row);
      } else {
        typedCommands.push(row);
      }
    }
    return [
      { label: "In the menu", commands: menuCommands },
      { label: "Typed only", commands: typedCommands },
    ].filter((group) => group.commands.length > 0);
  }, [chatMode]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="Command chat mode" className="pharos-segmented">
          {(["private", "group"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={chatMode === mode}
              onClick={() => setChatMode(mode)}
              className="pharos-focus-ring pharos-segmented-item min-h-11 px-3 text-xs sm:min-h-8"
            >
              {mode === "private" ? "Private" : "Group"}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {chatMode === "private"
            ? "Private DM syntax. Click any copy icon to copy a ready-to-paste example."
            : `Group syntax addressed to @${TELEGRAM_BOT_USERNAME}. Only group admins can change subscriptions.`}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2 lg:gap-10" aria-label="PharosWatchBot command reference">
        {groups.map((group, index) => {
          const headingId = `command-group-${group.label.toLowerCase().replaceAll(" ", "-")}`;
          const rows = (
            <dl className="mt-2 divide-y divide-border/45 border-y border-border/55">
              {group.commands.map((cmd) => {
                const displaySyntax = formatForChatMode(cmd.command, chatMode);
                const copyValue = resolveCopyText(cmd, chatMode);
                const rowKey = `${chatMode}:${cmd.command}`;
                const isCopied = copiedCommand === rowKey;
                return (
                  <div
                    key={cmd.command}
                    className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-0.5 py-2 sm:grid-cols-[minmax(12rem,auto)_minmax(0,1fr)_auto] sm:items-center sm:gap-x-3"
                  >
                    <dt className="min-w-0">
                      <code className="font-mono text-xs font-semibold text-foreground [overflow-wrap:anywhere]">
                        {displaySyntax}
                      </code>
                    </dt>
                    <dd className="col-span-1 min-w-0 text-xs leading-relaxed text-muted-foreground sm:col-auto">
                      {cmd.description}
                    </dd>
                    <div className="col-start-2 row-span-2 row-start-1 flex items-center justify-end sm:col-start-3 sm:row-span-1">
                      <button
                        type="button"
                        onClick={() => { void handleCopy(copyValue, rowKey); }}
                        aria-label={isCopied ? `Copied ${copyValue}` : `Copy ${copyValue}`}
                        title={isCopied ? "Copied" : `Copy ${copyValue}`}
                        className="pharos-focus-ring inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-border/60 bg-background/70 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:min-h-8 sm:min-w-8"
                      >
                        {isCopied ? (
                          <Check className="h-3.5 w-3.5 text-state-positive" aria-hidden="true" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
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
      <ul className="space-y-1 text-xs leading-relaxed text-muted-foreground">
        {TELEGRAM_COMMAND_REFERENCE_TIPS.map((tip) => (
          <li key={tip}>{tip}</li>
        ))}
      </ul>
    </div>
  );
}
