"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";

// Memory only: the root layout survives soft navigation; a document unload
// discards these secrets. Detached tokens remain recoverable until saved.
const pending = new Map<string, boolean>();
let pendingIssuances = 0;
const listeners = new Set<() => void>();
let detachedTokens: string[] = [];
const emptyTokens: string[] = [];
function publish() {
  detachedTokens = [...pending].filter(([, attached]) => !attached).map(([token]) => token);
  listeners.forEach((listener) => listener());
}
export function beginPendingApiKeyIssuance() {
  pendingIssuances += 1;
  publish();
  return () => {
    pendingIssuances -= 1;
    publish();
  };
}
export function retainPendingApiKey(token: string) {
  pending.set(token, true);
  publish();
  return () => {
    if (pending.has(token)) {
      pending.set(token, false);
      publish();
    }
  };
}
export function clearPendingApiKey(token: string) {
  pending.delete(token);
  publish();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The issuance page can unmount through Back or programmatic navigation. */
export function PendingApiKeyRecovery() {
  const tokens = useSyncExternalStore(subscribe, () => detachedTokens, () => emptyTokens);
  const issuing = useSyncExternalStore(subscribe, () => pendingIssuances > 0, () => false);
  const [copyError, setCopyError] = useState(false);
  useEffect(() => {
    if (!tokens.length && !issuing) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [tokens, issuing]);

  if (!tokens.length) return null;
  return (
    <section aria-label="Unsaved API keys" role="region" className="fixed inset-x-4 bottom-4 z-50 mx-auto max-h-[80vh] max-w-xl overflow-y-auto rounded-xl border border-amber-500/40 bg-background p-5 shadow-xl">
      <h2 className="text-lg font-semibold" tabIndex={-1} ref={(node) => { node?.focus(); }}>Save your API key before closing this tab</h2>
      <p className="mt-2 text-sm text-muted-foreground">You left the issuance page. Your unsaved key is still available here until you copy it or mark it saved.</p>
      {copyError ? <p role="alert" className="mt-2 text-sm">Copy failed. Select the token and copy it manually, then mark it saved.</p> : null}
      {tokens.map((token) => (
        <div key={token} className="mt-4 space-y-3">
          <code className="block break-all rounded-md bg-muted p-3 text-sm">{token}</code>
          <div className="flex gap-2">
            <Button type="button" onClick={() => void copyText(token).then((result) => {
              setCopyError(!result.ok);
              if (result.ok) clearPendingApiKey(token);
            })}>Copy API Key</Button>
            <Button type="button" variant="outline" onClick={() => clearPendingApiKey(token)}>I Saved This Key</Button>
          </div>
        </div>
      ))}
    </section>
  );
}
