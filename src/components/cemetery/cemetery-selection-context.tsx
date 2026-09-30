"use client";

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { parseCemeteryHash } from "@/lib/cemetery-selection";

export type CemeterySelectionSource = "hero" | "register" | "chart" | "facts" | "causes" | "hash";
export type CemeterySelectionHandler = (id: string, source: CemeterySelectionSource) => void;

export interface CemeterySelectionContextValue {
  /** The record currently addressed by a pin, a reveal, the hash or `setRecordHash`. */
  selectedId: string | null;
  /** Pins the grave in the hero; queued until the hero registers its handler. */
  pinGrave: (id: string, source: CemeterySelectionSource) => void;
  /** Reveals the record in the register; queued until the register registers its handler. */
  revealRecord: (id: string, source: CemeterySelectionSource) => void;
  registerPinGrave: (handler: CemeterySelectionHandler) => () => void;
  registerRevealRecord: (handler: CemeterySelectionHandler) => () => void;
  /** Replaces the URL hash with `#<id>` (no history entry); `null` clears it. */
  setRecordHash: (id: string | null) => void;
}

const CemeterySelectionContext = createContext<CemeterySelectionContextValue | null>(null);

/**
 * One handler slot. A request made before the handler registers is kept
 * (latest wins) and delivered on registration.
 */
function createChannel() {
  let handler: CemeterySelectionHandler | null = null;
  let pending: { id: string; source: CemeterySelectionSource } | null = null;
  return {
    dispatch(id: string, source: CemeterySelectionSource) {
      if (handler) handler(id, source);
      else pending = { id, source };
    },
    register(next: CemeterySelectionHandler): () => void {
      handler = next;
      const queued = pending;
      pending = null;
      if (queued) next(queued.id, queued.source);
      return () => {
        if (handler === next) handler = null;
      };
    },
  };
}

/**
 * Selection state lives in a closure store rather than React state so hash
 * handling can run inside effects and event listeners without cascading
 * renders; components read `selectedId` through `useSyncExternalStore`.
 */
function createSelectionStore(initialKnownIds: ReadonlySet<string>) {
  let knownIds = initialKnownIds;
  let selectedId: string | null = null;
  /** Hash last written by the provider; a hashchange carrying it is our own echo. */
  let writtenHash: string | null = null;
  const listeners = new Set<() => void>();
  const pinChannel = createChannel();
  const revealChannel = createChannel();

  const select = (id: string | null) => {
    if (selectedId === id) return;
    selectedId = id;
    for (const listener of listeners) listener();
  };

  const replaceHash = (fragment: string) => {
    if (window.location.hash === fragment) return;
    writtenHash = fragment;
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${fragment}`);
  };

  const pinGrave = (id: string, source: CemeterySelectionSource) => {
    if (!knownIds.has(id)) return;
    select(id);
    pinChannel.dispatch(id, source);
  };

  const revealRecord = (id: string, source: CemeterySelectionSource) => {
    if (!knownIds.has(id)) return;
    select(id);
    revealChannel.dispatch(id, source);
  };

  const applyLocationHash = () => {
    const target = parseCemeteryHash(window.location.hash, knownIds);
    if (target?.kind !== "record") return;
    if (target.legacy) replaceHash(`#${encodeURIComponent(target.id)}`);
    pinGrave(target.id, "hash");
    revealRecord(target.id, "hash");
  };

  return {
    setKnownIds(next: ReadonlySet<string>) {
      knownIds = next;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSelectedId: () => selectedId,
    /** Parses the hash now and on every `hashchange`; returns the unsubscribe. */
    watchLocationHash(): () => void {
      const handleHashChange = () => {
        const echoed = writtenHash !== null && window.location.hash === writtenHash;
        writtenHash = null;
        if (!echoed) applyLocationHash();
      };
      applyLocationHash();
      window.addEventListener("hashchange", handleHashChange);
      return () => window.removeEventListener("hashchange", handleHashChange);
    },
    actions: {
      pinGrave,
      revealRecord,
      registerPinGrave: pinChannel.register,
      registerRevealRecord: revealChannel.register,
      setRecordHash(id: string | null) {
        if (id === null) {
          select(null);
          replaceHash("");
          return;
        }
        if (!knownIds.has(id)) return;
        select(id);
        replaceHash(`#${encodeURIComponent(id)}`);
      },
    },
  };
}

const getServerSelectedId = () => null;

/**
 * Sole owner of `location.hash` on `/cemetery/`. Parses the hash on mount and
 * on `hashchange`; a record hash pins the grave and reveals the record, a
 * legacy `#obituary-<id>` is normalised to `#<id>`. The provider never
 * scrolls: registered handlers own scrolling and reduced motion.
 */
export function CemeterySelectionProvider({
  knownIds,
  children,
}: {
  knownIds: readonly string[];
  children: ReactNode;
}) {
  const knownIdSet = useMemo(() => new Set(knownIds), [knownIds]);
  const [store] = useState(() => createSelectionStore(knownIdSet));
  const selectedId = useSyncExternalStore(store.subscribe, store.getSelectedId, getServerSelectedId);

  useEffect(() => {
    store.setKnownIds(knownIdSet);
  }, [store, knownIdSet]);

  useEffect(() => store.watchLocationHash(), [store]);

  const value = useMemo<CemeterySelectionContextValue>(
    () => ({ selectedId, ...store.actions }),
    [selectedId, store],
  );

  return <CemeterySelectionContext.Provider value={value}>{children}</CemeterySelectionContext.Provider>;
}

export function useCemeterySelection(): CemeterySelectionContextValue {
  const context = useContext(CemeterySelectionContext);
  if (!context) throw new Error("useCemeterySelection must be used inside CemeterySelectionProvider");
  return context;
}
