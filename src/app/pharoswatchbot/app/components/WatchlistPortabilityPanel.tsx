"use client";

import { useMemo, useState } from "react";
import { Copy, Download, Upload } from "lucide-react";
import type {
  TelegramMiniAppOperation,
  TelegramMiniAppPortabilityResponse,
  TelegramMiniAppState,
} from "../types";
import { MiniButton } from "./MiniButton";

type ImportPreview = Extract<TelegramMiniAppPortabilityResponse["result"], { kind: "watchlist-import-preview" }>;

function PreviewList({ label, ids, resolveLabel }: {
  label: string;
  ids: readonly string[];
  resolveLabel: (id: string) => string;
}) {
  return (
    <div>
      <p className="text-xs font-semibold text-foreground">{label}: {ids.length}</p>
      {ids.length > 0 ? (
        <ul className="mt-1 max-h-32 space-y-1 overflow-y-auto rounded-md border border-border/55 bg-background/45 p-2 text-xs text-muted-foreground">
          {ids.map((id) => <li key={id} className="break-words">{resolveLabel(id)}</li>)}
        </ul>
      ) : <p className="mt-1 text-xs text-muted-foreground">None</p>}
    </div>
  );
}

function CoverageList({ label, entries, resolveLabel }: {
  label: string;
  entries: readonly { id: string; alertTypes: readonly string[] }[];
  resolveLabel: (id: string) => string;
}) {
  return (
    <div>
      <p className="text-xs font-semibold text-foreground">{label}: {entries.length}</p>
      {entries.length > 0 ? (
        <ul className="mt-1 max-h-32 space-y-1 overflow-y-auto rounded-md border border-border/55 bg-background/45 p-2 text-xs text-muted-foreground">
          {entries.map((entry) => (
            <li key={`${entry.id}-${entry.alertTypes.join("-")}`} className="break-words">
              {resolveLabel(entry.id)}: {entry.alertTypes.join(", ")}
            </li>
          ))}
        </ul>
      ) : <p className="mt-1 text-xs text-muted-foreground">None</p>}
    </div>
  );
}

export function WatchlistPortabilityPanel({
  state,
  canMutate,
  canReadPortability,
  isMutating,
  pendingOperation,
  onExport,
  onPreview,
  onConfirm,
}: {
  state: TelegramMiniAppState;
  canMutate: boolean;
  canReadPortability: boolean;
  isMutating: boolean;
  pendingOperation: TelegramMiniAppOperation | null;
  onExport: () => Promise<TelegramMiniAppPortabilityResponse | null>;
  onPreview: (token: string) => Promise<TelegramMiniAppPortabilityResponse | null>;
  onConfirm: (operation: Extract<TelegramMiniAppOperation, { kind: "confirm-watchlist-import" }>) => Promise<unknown>;
}) {
  const [exportToken, setExportToken] = useState<string | null>(null);
  const [importToken, setImportToken] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const labels = useMemo(() => {
    const values = new Map<string, string>();
    for (const coin of state.catalog.searchableCoins) values.set(coin.stablecoinId, `${coin.symbol} (${coin.stablecoinId})`);
    for (const preset of state.presets) values.set(preset.id, preset.label);
    return values;
  }, [state.catalog.searchableCoins, state.presets]);
  const resolveLabel = (id: string) => labels.get(id) ?? id;
  const readDisabled = !canReadPortability || isMutating;
  const writeDisabled = !canMutate || isMutating;

  const handleExport = async () => {
    const response = await onExport();
    if (response?.result.kind === "watchlist-export") setExportToken(response.result.token);
  };
  const handleCopy = async () => {
    if (!exportToken) return;
    try {
      await navigator.clipboard.writeText(exportToken);
      setCopyStatus("Copied.");
    } catch {
      setCopyStatus("Select and copy the token above.");
    }
  };
  const handlePreview = async () => {
    const response = await onPreview(importToken);
    if (response?.result.kind === "watchlist-import-preview") setPreview(response.result);
  };
  const handleConfirm = async () => {
    if (!preview) return;
    const result = await onConfirm({
      kind: "confirm-watchlist-import",
      token: importToken,
      expectedPreferenceGeneration: preview.expectedPreferenceGeneration,
      previewFingerprint: preview.previewFingerprint,
    });
    if (result) {
      setPreview(null);
      setImportToken("");
    }
  };

  return (
    <section className="rounded-2xl border border-border/70 bg-card/90 p-4">
      <h2 className="text-sm font-semibold text-foreground">Watchlist transfer</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Export direct rows and presets as one lossless token, or preview a replacement before applying it.
      </p>

      <div className="mt-4">
        <MiniButton
          variant="secondary"
          disabled={readDisabled}
          loading={pendingOperation?.kind === "export-watchlist"}
          onClick={() => void handleExport()}
        >
          <Download className="h-4 w-4" aria-hidden="true" /> Export watchlist
        </MiniButton>
        {exportToken ? (
          <div className="mt-3">
            <label htmlFor="mini-watchlist-export-token" className="text-xs font-semibold text-foreground">Portable token</label>
            <textarea
              id="mini-watchlist-export-token"
              readOnly
              value={exportToken}
              rows={4}
              className="pharos-focus-ring mt-2 w-full resize-y rounded-lg border border-border/65 bg-background/70 p-3 font-mono text-xs text-foreground"
              aria-describedby="mini-watchlist-export-token-note"
              onFocus={(event) => event.currentTarget.select()}
            />
            <p id="mini-watchlist-export-token-note" className="mt-2 text-xs text-muted-foreground">This token excludes global settings, quiet hours, timezone, snoozes, pending actions, and delivery history.</p>
            <div className="mt-2">
              <MiniButton variant="secondary" onClick={() => void handleCopy()}>
                <Copy className="h-4 w-4" aria-hidden="true" /> Copy token
              </MiniButton>
            </div>
            {copyStatus ? <p role="status" className="mt-2 text-xs text-muted-foreground">{copyStatus}</p> : null}
          </div>
        ) : null}
      </div>

      <div className="mt-5 border-t border-border/60 pt-4">
        <label htmlFor="mini-watchlist-import-token" className="text-xs font-semibold text-foreground">Import a portable token</label>
        <textarea
          id="mini-watchlist-import-token"
          value={importToken}
          rows={4}
          disabled={readDisabled}
          placeholder="Paste a portable token"
          className="pharos-focus-ring mt-2 w-full resize-y rounded-lg border border-border/65 bg-background/70 p-3 font-mono text-xs text-foreground placeholder:font-sans placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
          onChange={(event) => {
            setImportToken(event.target.value);
            setPreview(null);
          }}
        />
        <div className="mt-2">
          <MiniButton
            disabled={readDisabled || importToken.trim().length === 0}
            loading={pendingOperation?.kind === "preview-watchlist-import"}
            onClick={() => void handlePreview()}
          >
            <Upload className="h-4 w-4" aria-hidden="true" /> Preview replacement
          </MiniButton>
        </div>
      </div>

      {preview ? (
        <div className="mt-4 border-t border-border/60 pt-4" aria-live="polite">
          <h3 className="text-sm font-semibold text-foreground">Exact replacement preview</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Only direct/local rows and followed presets are replaced. Global settings, quiet hours, timezone, and snoozes on retained rows stay unchanged. Removing a row removes its per-coin snooze.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <PreviewList label="Direct rows added" ids={preview.preview.directAdds} resolveLabel={resolveLabel} />
            <PreviewList label="Direct rows removed" ids={preview.preview.directRemoves} resolveLabel={resolveLabel} />
            <PreviewList label="Direct rows changed" ids={preview.preview.directChanges} resolveLabel={resolveLabel} />
            <PreviewList label="Presets added" ids={preview.preview.presetAdds} resolveLabel={resolveLabel} />
            <PreviewList label="Presets removed" ids={preview.preview.presetRemoves} resolveLabel={resolveLabel} />
            <PreviewList label="Presets changed" ids={preview.preview.presetChanges} resolveLabel={resolveLabel} />
          </div>
          <div className="mt-4 border-t border-border/50 pt-3">
            <h4 className="text-xs font-semibold text-foreground">Coverage effect</h4>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <CoverageList label="Direct coverage broadened" entries={preview.preview.directBroadenedCoverage} resolveLabel={resolveLabel} />
              <CoverageList label="Direct coverage removed" entries={preview.preview.directRemovedCoverage} resolveLabel={resolveLabel} />
              <CoverageList label="Preset coverage broadened" entries={preview.preview.presetBroadenedCoverage} resolveLabel={resolveLabel} />
              <CoverageList label="Preset coverage removed" entries={preview.preview.presetRemovedCoverage} resolveLabel={resolveLabel} />
            </div>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <MiniButton
              variant="danger"
              disabled={writeDisabled}
              loading={pendingOperation?.kind === "confirm-watchlist-import"}
              onClick={() => void handleConfirm()}
            >
              Apply exact replacement
            </MiniButton>
            <MiniButton variant="secondary" disabled={isMutating} onClick={() => setPreview(null)}>Discard preview</MiniButton>
          </div>
        </div>
      ) : null}
    </section>
  );
}
