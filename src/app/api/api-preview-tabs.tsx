"use client";

import { useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";
import { API_PATHS } from "@shared/lib/api-endpoints";
import { API_PAGE_ANCHORS, PUBLIC_API_HOST, PUBLIC_API_KEY_HEADER } from "@shared/lib/public-api-contract";
import type { ApiPreviewExamples } from "./api-landing-data";

type PreviewTabId = "risk-gate" | "compliance" | "mcp";
type McpClientId = "cursor" | "vscode" | "claude-code" | "claude-desktop";

const PREVIEW_TABS: readonly { id: PreviewTabId; label: string }[] = [
  { id: "risk-gate", label: "Risk-Gate" },
  { id: "compliance", label: "Compliance" },
  { id: "mcp", label: "MCP" },
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

/** What each example response carries, listed beside the request so the panel reads at a glance. */
const RISK_GATE_FIELDS: readonly [string, string][] = [
  ["safety", "Grade, score, pillars, publication status"],
  ["dews", "Stress score and band"],
  ["peg", "Price, source, deviation, active depeg"],
  ["ddr", "Recovery outlook during a depeg"],
  ["liquidity", "DEX liquidity score, TVL, volume"],
  ["redemption", "Route, access model, capacity, fees"],
  ["controls", "Freeze and blacklist exposure"],
  ["compliance", "MiCA and GENIUS status"],
  ["_meta", "Per-source read time, budget, reason"],
];

const COMPLIANCE_FIELDS: readonly [string, string][] = [
  ["regimes.genius", "Statutory dates and rulemaking phase"],
  ["coin.mica", "Status, token type, authority, entity"],
  ["coin.genius", "Applicability, status, pathway, disclosures"],
  ["*UnavailableReason", "not-reviewed, never a silent pass"],
  ["_meta", "Review freshness"],
];

function FieldList({ fields }: { fields: readonly [string, string][] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 px-1 text-xs">
      {fields.map(([field, description]) => (
        <div key={field} className="contents">
          <dt className="font-mono text-foreground">{field}</dt>
          <dd className="text-muted-foreground">{description}</dd>
        </div>
      ))}
    </dl>
  );
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

const EXAMPLE_GRID_CLASS_NAME = "grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start";

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
            <div className="min-w-0 space-y-4">
              <CodePanel label="Request (curl)" code={RISK_GATE_CURL} />
              <FieldList fields={RISK_GATE_FIELDS} />
            </div>
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
            <div className="min-w-0 space-y-4">
              <CodePanel label="Request (curl)" code={COMPLIANCE_CURL} />
              <FieldList fields={COMPLIANCE_FIELDS} />
            </div>
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
            . Five core tools work with any active API key (including supporter and free partner keys);{" "}
            <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs text-foreground">get_risk_check</code>{" "}
            and{" "}
            <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs text-foreground">get_compliance</code>{" "}
            require a Commercial or Institutional key.
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
    </section>
  );
}
