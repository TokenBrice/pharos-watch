"use client";

import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";
import { API_PATHS } from "@shared/lib/api-endpoints";
import { API_PAGE_ANCHORS, PUBLIC_API_HOST, PUBLIC_API_KEY_HEADER } from "@shared/lib/public-api-contract";
import { renderSafetyBadgeSvg } from "@shared/lib/safety-badge-svg";
import type { ApiPreviewExamples } from "./api-landing-data";

type PreviewTabId = "risk-gate" | "compliance" | "mcp" | "badge";
type McpClientId = "cursor" | "vscode" | "claude-code" | "claude-desktop";

const PREVIEW_TABS: readonly { id: PreviewTabId; label: string }[] = [
  { id: "risk-gate", label: "Risk-Gate" },
  { id: "compliance", label: "Compliance" },
  { id: "mcp", label: "MCP" },
  { id: "badge", label: "Safety Badge" },
] as const;

const MCP_CLIENTS: readonly { id: McpClientId; label: string; fileHint: string; snippet: string }[] = [
  {
    id: "cursor",
    label: "Cursor",
    fileHint: ".cursor/mcp.json",
    snippet: JSON.stringify(
      {
        mcpServers: {
          pharos: {
            type: "http",
            url: `${PUBLIC_API_HOST}${API_PATHS.mcp()}`,
            headers: {
              [PUBLIC_API_KEY_HEADER]: "${PHAROS_API_KEY}",
            },
          },
        },
      },
      null,
      2,
    ),
  },
  {
    id: "vscode",
    label: "VS Code",
    fileHint: ".vscode/mcp.json",
    snippet: JSON.stringify(
      {
        inputs: [
          {
            type: "promptString",
            id: "pharos_api_key",
            description: "Pharos API key",
            password: true,
          },
        ],
        servers: {
          pharos: {
            type: "http",
            url: `${PUBLIC_API_HOST}${API_PATHS.mcp()}`,
            headers: {
              [PUBLIC_API_KEY_HEADER]: "${input:pharos_api_key}",
            },
          },
        },
      },
      null,
      2,
    ),
  },
  {
    id: "claude-code",
    label: "Claude Code",
    fileHint: "Shell command",
    snippet: `claude mcp add --transport http pharos ${PUBLIC_API_HOST}${API_PATHS.mcp()} \\\n  --header "${PUBLIC_API_KEY_HEADER}: $PHAROS_API_KEY"`,
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    fileHint: "claude_desktop_config.json (via mcp-remote)",
    snippet: JSON.stringify(
      {
        mcpServers: {
          pharos: {
            command: "npx",
            args: [
              "-y",
              "mcp-remote@latest",
              `${PUBLIC_API_HOST}${API_PATHS.mcp()}`,
              "--header",
              `${PUBLIC_API_KEY_HEADER}:\${PHAROS_API_KEY}`,
            ],
            env: {
              PHAROS_API_KEY: "ph_live_REPLACE_WITH_YOUR_KEY",
            },
          },
        },
      },
      null,
      2,
    ),
  },
] as const;

const RISK_GATE_CURL = `curl "${PUBLIC_API_HOST}${API_PATHS.riskCheck()}?ids=usdc-circle" \\\n  -H "${PUBLIC_API_KEY_HEADER}: $PHAROS_API_KEY"`;

const COMPLIANCE_CURL = `curl "${PUBLIC_API_HOST}${API_PATHS.complianceCoin("usdc-circle")}" \\\n  -H "${PUBLIC_API_KEY_HEADER}: $PHAROS_API_KEY"`;

const BADGE_URL = `${PUBLIC_API_HOST}${API_PATHS.safetyBadge("usdc-circle")}`;
const BADGE_MARKDOWN = `[![Pharos Safety Score](${BADGE_URL})](https://pharos.watch/stablecoin/usdc-circle/)`;
const BADGE_HTML = `<a href="https://pharos.watch/stablecoin/usdc-circle/"><img src="${BADGE_URL}?style=card&theme=dark" alt="Pharos Safety Score for USDC" /></a>`;

function badgeDataUri(badge: NonNullable<ApiPreviewExamples["badge"]>, style: "flat" | "card", theme: "dark" | "light"): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(renderSafetyBadgeSvg({ kind: "rated", ...badge }, { style, theme }))}`;
}

function CodePanel({ label, code, scroll = false }: { label: string; code: string; scroll?: boolean }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-[var(--code-surface-bg)] text-[var(--code-surface-fg)]">
      <div className="flex items-center justify-between border-b border-[var(--code-surface-border)] px-3 py-2">
        <span className="text-2xs font-semibold text-[var(--code-surface-muted)]">{label}</span>
        <CopyButton text={code} className="size-8 shrink-0" />
      </div>
      <pre className={cn("overflow-x-auto px-3 py-3 font-mono text-xs leading-relaxed", scroll && "max-h-96 overflow-y-auto")}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

const EXAMPLE_GRID_CLASS_NAME = "grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start";

export function ApiPreviewTabs({ examples }: { examples: ApiPreviewExamples }) {
  const exampleNote = `Exact response shape. The Safety grade and compliance fields come from the ${examples.asOfDate} release; market fields are illustrative.`;
  const [activeTab, setActiveTab] = useState<PreviewTabId>("risk-gate");
  const [activeMcpClient, setActiveMcpClient] = useState<McpClientId>("cursor");
  const mcpConfig = MCP_CLIENTS.find((client) => client.id === activeMcpClient) ?? MCP_CLIENTS[0];

  return (
    <section
      id={API_PAGE_ANCHORS.integrationPreview}
      aria-labelledby="api-preview-title"
      className="pharos-card-shell scroll-mt-20 space-y-5 px-5 py-6 sm:px-6"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1.5">
          <p className="pharos-label">Integration previews</p>
          <h2 id="api-preview-title" className="text-2xl font-semibold tracking-tight text-foreground">
            See the full response before you ask for a key
          </h2>
        </div>
        <div role="tablist" aria-label="Integration preview tabs" className="flex flex-wrap gap-2">
          {PREVIEW_TABS.map((tab) => {
            const selected = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "pharos-control-pill pharos-focus-ring cursor-pointer",
                  selected && "border-foreground/40 bg-foreground text-background hover:bg-foreground/90",
                )}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {activeTab === "risk-gate" ? (
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            One call for vault allocators, DEX routers, and treasury risk desks. Pass up to 25 canonical IDs or{" "}
            <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs text-foreground">chain:address</code>{" "}
            contracts to receive Safety Score, DEWS stress, peg deviation, depeg outlook, DEX liquidity, redemption capacity,
            freeze controls, and MiCA/GENIUS status in one response. Every block states when its source was read, and a
            missing input returns a reason instead of a default. Commercial or Institutional key required.
          </p>
          <div className={EXAMPLE_GRID_CLASS_NAME}>
            <CodePanel label="Request (curl)" code={RISK_GATE_CURL} />
            <CodePanel label="Example response (200 OK)" code={examples.riskGateResponse} scroll />
          </div>
          <p className="pharos-meta">{exampleNote}</p>
        </div>
      ) : null}

      {activeTab === "compliance" ? (
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Structured EU MiCA and U.S. GENIUS Act dossiers across tracked stablecoins, preserving explicit{" "}
            <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs text-foreground">not-reviewed</code>{" "}
            nulls and statutory rulemaking dates. Query the full filtered registry or a single coin. Commercial or
            Institutional key required.
          </p>
          <div className={EXAMPLE_GRID_CLASS_NAME}>
            <CodePanel label="Request (curl)" code={COMPLIANCE_CURL} />
            <CodePanel label="Example response (200 OK)" code={examples.complianceResponse} scroll />
          </div>
          <p className="pharos-meta">Dossier fields as reviewed in the {examples.asOfDate} release.</p>
        </div>
      ) : null}

      {activeTab === "mcp" ? (
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Stateless Streamable HTTP MCP server at{" "}
            <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
              {PUBLIC_API_HOST}{API_PATHS.mcp()}
            </code>{" "}
            exposing seven read-only Pharos tools authenticated with{" "}
            <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
              {PUBLIC_API_KEY_HEADER}
            </code>
            . Commercial or Institutional key required.
          </p>
          <div className="flex flex-wrap gap-2">
            {MCP_CLIENTS.map((client) => {
              const selected = client.id === mcpConfig.id;
              return (
                <button
                  key={client.id}
                  type="button"
                  onClick={() => setActiveMcpClient(client.id)}
                  className={cn(
                    "pharos-control-pill pharos-focus-ring cursor-pointer text-xs",
                    selected && "border-foreground/40 bg-foreground text-background hover:bg-foreground/90",
                  )}
                >
                  {client.label}
                </button>
              );
            })}
          </div>
          <CodePanel label={`${mcpConfig.label} (${mcpConfig.fileHint})`} code={mcpConfig.snippet} />
        </div>
      ) : null}

      {activeTab === "badge" ? (
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Live no-key SVG Safety Score badges for GitHub READMEs, docs, and protocol frontends. Supports{" "}
            <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs text-foreground">style=flat|card</code>{" "}
            and{" "}
            <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs text-foreground">theme=dark|light</code>.
            Held or stale publications render an explicit uncached Unavailable state.
          </p>
          {examples.badge ? (
            <div className="pharos-inset flex flex-wrap items-center gap-4 p-4">
              <img src={badgeDataUri(examples.badge, "flat", "dark")} alt={`Pharos flat dark safety badge for ${examples.badge.symbol}`} height={26} />
              <img src={badgeDataUri(examples.badge, "flat", "light")} alt={`Pharos flat light safety badge for ${examples.badge.symbol}`} height={26} />
              <img src={badgeDataUri(examples.badge, "card", "dark")} alt={`Pharos card dark safety badge for ${examples.badge.symbol}`} height={60} />
              <p className="pharos-meta w-full">Rendered with the grade from the {examples.asOfDate} release; the live badge always shows the current grade.</p>
            </div>
          ) : null}
          <div className="grid gap-3 lg:grid-cols-2">
            <CodePanel label="Markdown embed" code={BADGE_MARKDOWN} />
            <CodePanel label="HTML embed (card)" code={BADGE_HTML} />
          </div>
        </div>
      ) : null}
    </section>
  );
}
