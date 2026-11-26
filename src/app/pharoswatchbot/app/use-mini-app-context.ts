"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import {
  TELEGRAM_MINI_APP_CATALOG_VERSION,
  TELEGRAM_MINI_APP_CONTRACT_VERSION,
} from "@shared/lib/telegram-mini-app-contract";
import { MiniAppRequestError } from "./error-messages";
import { isMiniAppVersionMismatch, postMiniAppContext, refreshMiniAppBundleOnce } from "./mini-app-api";
import type {
  TelegramMiniAppActiveDepeg,
  TelegramMiniAppCoinSignal,
  TelegramMiniAppContextProvenance,
  TelegramMiniAppContextRequest,
  TelegramMiniAppPresetSummary,
  TelegramMiniAppState,
} from "./types";
import type { MiniAppScreen } from "./use-mini-app-view";

const SESSION_ENDPOINT = API_PATHS.telegramMiniAppSession();
const MAX_WATCHED_CONTEXT_COINS = 20;
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export interface HomePegContext {
  status: "idle" | "ok" | "unavailable";
  events: TelegramMiniAppActiveDepeg[];
  /** True when the chat watches more than the 20-coin live-context cap. */
  truncated: boolean;
}

export interface CoinLiveContext {
  status: "idle" | "ok" | "unavailable";
  signal: TelegramMiniAppCoinSignal | null;
  depeg: TelegramMiniAppActiveDepeg | null;
  depegProvenance: TelegramMiniAppContextProvenance | null;
}

export interface PresetsLiveContext {
  status: "idle" | "ok" | "unavailable";
  byId: ReadonlyMap<string, TelegramMiniAppPresetSummary>;
}

interface CachedCoinEntry {
  signal: TelegramMiniAppCoinSignal;
  depeg: TelegramMiniAppActiveDepeg | null;
  depegProvenance: TelegramMiniAppContextProvenance;
  expiresAtMs: number | null;
}

interface CachedHomeLane {
  status: "ok" | "unavailable";
  events: TelegramMiniAppActiveDepeg[];
  expiresAtMs: number | null;
}

interface CachedPresetsEntry {
  status: "ok" | "unavailable";
  byId: ReadonlyMap<string, TelegramMiniAppPresetSummary>;
  expiresAtMs: number | null;
}

interface LaunchContextCache {
  launchKey: string;
  coinsById: ReadonlyMap<string, CachedCoinEntry>;
  failedCoinKeys: ReadonlySet<string>;
  homeDepegLaneByKey: ReadonlyMap<string, CachedHomeLane>;
  presets: CachedPresetsEntry | null;
}

const EMPTY_PRESETS_MAP: ReadonlyMap<string, TelegramMiniAppPresetSummary> = new Map();

function provenanceExpiresAtMs(
  provenance: TelegramMiniAppContextProvenance,
  serverNowSec: number,
  receivedWallMs: number,
): number | null {
  if (provenance.status !== "ok" || provenance.observedAt == null) return null;
  // Server admits `nowSec - observedAt <= budgetSec`, so the first invalid second is `observedAt + budgetSec + 1`.
  const remainingSec = Math.max(1, (provenance.observedAt + provenance.budgetSec + 1) - serverNowSec);
  return receivedWallMs + remainingSec * 1000;
}

function minExpiryMs(values: readonly (number | null)[]): number | null {
  let min: number | null = null;
  for (const value of values) {
    if (value == null) continue;
    min = min == null ? value : Math.min(min, value);
  }
  return min;
}

function isExpiredEntry(expiresAtMs: number | null, nowMs: number): boolean {
  return expiresAtMs != null && nowMs >= expiresAtMs;
}

function createEmptyCache(launchKey: string): LaunchContextCache {
  return {
    launchKey,
    coinsById: new Map(),
    failedCoinKeys: new Set(),
    homeDepegLaneByKey: new Map(),
    presets: null,
  };
}

const EMPTY_CACHE = createEmptyCache("");

/**
 * Select up to 20 unique selectable watched coins for Home live peg context:
 * direct subscriptions first (sorted by catalog rank), then top members of
 * followed presets in resolver order, alongside the total unique selectable
 * count so callers can avoid totalizing over a truncated sample (R7).
 */
function selectWatchedCoinIdsForContext(
  state: TelegramMiniAppState,
  limit = MAX_WATCHED_CONTEXT_COINS,
): { coinIds: string[]; totalSelectableCount: number } {
  const rankById = new Map<string, number>();
  for (const coin of state.catalog.searchableCoins) {
    rankById.set(coin.stablecoinId, coin.rank ?? Number.MAX_SAFE_INTEGER);
  }
  const picked: string[] = [];
  const seen = new Set<string>();
  const addIfSelectable = (stablecoinId: string) => {
    if (seen.has(stablecoinId) || !rankById.has(stablecoinId)) return;
    seen.add(stablecoinId);
    if (picked.length < limit) picked.push(stablecoinId);
  };
  const rankedDirect = [...state.subscriptions].sort(
    (left, right) =>
      (rankById.get(left.stablecoinId) ?? Number.MAX_SAFE_INTEGER)
      - (rankById.get(right.stablecoinId) ?? Number.MAX_SAFE_INTEGER)
      || left.symbol.localeCompare(right.symbol),
  );
  for (const coin of rankedDirect) addIfSelectable(coin.stablecoinId);
  for (const preset of state.presets) {
    for (const memberId of preset.memberIds ?? []) addIfSelectable(memberId);
  }
  return { coinIds: picked, totalSelectableCount: seen.size };
}

export interface UseMiniAppContextArgs {
  enabled: boolean;
  initData: string;
  state: TelegramMiniAppState | null;
  screen: MiniAppScreen;
  isNewUser: boolean;
  /** Increment on explicit session refresh to allow re-fetching live context. */
  refreshGeneration: number;
  onSessionAuthExpired: () => void;
  onUpdateRequired: () => void;
}

export interface UseMiniAppContextResult {
  homePegContext: HomePegContext;
  coinLiveContext: CoinLiveContext;
  presetsLiveContext: PresetsLiveContext;
}

/**
 * Loads Contract v10 on-demand scoped live risk context asynchronously AFTER
 * initial preferences render. Cached per verified launch + viewer + version,
 * deduplicating concurrent reads and discarding late responses from prior
 * launches or screens.
 */
export function useMiniAppContext({
  enabled,
  initData,
  state,
  screen,
  isNewUser,
  refreshGeneration,
  onSessionAuthExpired,
  onUpdateRequired,
}: UseMiniAppContextArgs): UseMiniAppContextResult {
  const viewerUserId = state?.viewer.userId ?? "";
  const launchKey = enabled
    ? `${initData}\0${viewerUserId}\0${TELEGRAM_MINI_APP_CONTRACT_VERSION}\0${TELEGRAM_MINI_APP_CATALOG_VERSION}\0${refreshGeneration}`
    : "";

  const [cache, setCache] = useState<LaunchContextCache>(() => createEmptyCache(""));
  const [retryNonce, setRetryNonce] = useState(0);
  const [clockMs, setClockMs] = useState(0);
  const inFlightKeysRef = useRef<Set<string>>(new Set());
  const retriedKeysRef = useRef<Set<string>>(new Set());
  const pendingRetryRef = useRef<{ key: string; timerId: number } | null>(null);
  const epochRef = useRef(0);
  const activeLaunchKeyRef = useRef(launchKey);
  const activeDesiredKeyRef = useRef<string | null>(null);
  const onSessionAuthExpiredRef = useRef(onSessionAuthExpired);
  const onUpdateRequiredRef = useRef(onUpdateRequired);

  const clearPendingRetry = () => {
    if (pendingRetryRef.current != null) {
      window.clearTimeout(pendingRetryRef.current.timerId);
      retriedKeysRef.current.delete(pendingRetryRef.current.key);
      pendingRetryRef.current = null;
    }
  };

  useIsomorphicLayoutEffect(() => {
    onSessionAuthExpiredRef.current = onSessionAuthExpired;
    onUpdateRequiredRef.current = onUpdateRequired;
  });

  useEffect(() => {
    if (activeLaunchKeyRef.current !== launchKey) {
      activeLaunchKeyRef.current = launchKey;
      epochRef.current += 1;
      inFlightKeysRef.current.clear();
      retriedKeysRef.current.clear();
      clearPendingRetry();
    }
  }, [launchKey]);

  useEffect(() => () => {
    epochRef.current += 1;
    clearPendingRetry();
  }, []);

  const activeCache = cache.launchKey === launchKey ? cache : EMPTY_CACHE;

  const watchedSelection = useMemo(
    () => (state && !isNewUser ? selectWatchedCoinIdsForContext(state) : { coinIds: [], totalSelectableCount: 0 }),
    [isNewUser, state],
  );
  const watchedCoinIds = watchedSelection.coinIds;
  const homeTruncated = watchedSelection.totalSelectableCount > watchedCoinIds.length
    || Boolean(state?.presets.some((preset) => preset.memberIds == null));
  const homeCoinKey = useMemo(
    () => [...watchedCoinIds].sort().join(","),
    [watchedCoinIds],
  );
  const coinScreenId = screen.name === "coin" ? screen.coinId : null;
  const coinScreenSelectable = useMemo(
    () => Boolean(
      coinScreenId
      && state?.catalog.searchableCoins.some((coin) => coin.stablecoinId === coinScreenId),
    ),
    [coinScreenId, state?.catalog.searchableCoins],
  );

  // Determine the single scoped request (if any) needed by the currently visible screen.
  const desired = useMemo<{ key: string; request: TelegramMiniAppContextRequest } | null>(() => {
    if (!enabled || !state) return null;
    if (screen.name === "home" && !isNewUser && watchedCoinIds.length > 0) {
      return {
        key: `home:${homeCoinKey}`,
        request: { kind: "coins", stablecoinIds: watchedCoinIds },
      };
    }
    if (screen.name === "coin" && coinScreenId && coinScreenSelectable) {
      return {
        key: `coin:${coinScreenId}`,
        request: { kind: "coins", stablecoinIds: [coinScreenId] },
      };
    }
    if (screen.name === "add-group") {
      return {
        key: "presets",
        request: { kind: "presets" },
      };
    }
    return null;
  }, [coinScreenId, coinScreenSelectable, enabled, homeCoinKey, isNewUser, screen.name, state, watchedCoinIds]);

  const desiredKey = desired?.key ?? null;
  useIsomorphicLayoutEffect(() => {
    activeDesiredKeyRef.current = desiredKey;
  });

  useEffect(() => () => {
    clearPendingRetry();
  }, [desiredKey, launchKey]);

  const activeExpiryMs = useMemo(() => {
    if (!desired) return null;
    if (desired.request.kind === "presets") return activeCache.presets?.expiresAtMs ?? null;
    if (desired.key.startsWith("coin:")) {
      return activeCache.coinsById.get(desired.request.stablecoinIds[0]!)?.expiresAtMs ?? null;
    }
    return activeCache.homeDepegLaneByKey.get(homeCoinKey)?.expiresAtMs ?? null;
  }, [activeCache, desired, homeCoinKey]);

  const lastFiredExpiryRef = useRef<number | null>(null);
  // Expire cached live evidence on schedule (and on visibility return) so a continuously
  // open Mini App never keeps displaying expired peg/DEWS/Safety verdicts past their budget.
  useEffect(() => {
    if (!enabled || activeExpiryMs == null) return undefined;
    let timerId: number | undefined;
    const fireOnce = () => {
      if (lastFiredExpiryRef.current === activeExpiryMs) return;
      lastFiredExpiryRef.current = activeExpiryMs;
      setClockMs(Date.now());
    };
    const schedule = () => {
      const remainingMs = activeExpiryMs - Date.now();
      if (remainingMs <= 0) {
        fireOnce();
        return;
      }
      window.clearTimeout(timerId);
      timerId = window.setTimeout(fireOnce, Math.min(remainingMs, 2_147_483_647));
    };
    schedule();
    const onVisibility = () => {
      if (document.visibilityState === "visible") schedule();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      window.clearTimeout(timerId);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [activeExpiryMs, enabled]);

  const isCached = useMemo(() => {
    if (!desired) return true;
    if (desired.request.kind === "presets") {
      return activeCache.presets != null && !isExpiredEntry(activeCache.presets.expiresAtMs, clockMs);
    }
    if (desired.key.startsWith("coin:")) {
      const id = desired.request.stablecoinIds[0]!;
      const cached = activeCache.coinsById.get(id);
      if (cached && !isExpiredEntry(cached.expiresAtMs, clockMs)) return true;
      return activeCache.failedCoinKeys.has(desired.key);
    }
    const lane = activeCache.homeDepegLaneByKey.get(homeCoinKey);
    return lane != null && !isExpiredEntry(lane.expiresAtMs, clockMs);
  }, [activeCache, clockMs, desired, homeCoinKey]);

  useEffect(() => {
    if (!enabled || !desired || !launchKey || isCached) return;
    if (inFlightKeysRef.current.has(desired.key)) return;
    if (pendingRetryRef.current?.key === desired.key) return;

    inFlightKeysRef.current.add(desired.key);
    const requestEpoch = epochRef.current;
    const capturedKey = desired.key;
    const capturedHomeKey = homeCoinKey;
    const capturedRequest = desired.request;

    void postMiniAppContext(SESSION_ENDPOINT, {
      initData,
      contextRequest: capturedRequest,
    })
      .then((response) => {
        if (epochRef.current !== requestEpoch || activeLaunchKeyRef.current !== launchKey) return;
        const receivedWallMs = Date.now();
        setClockMs(receivedWallMs);
        setCache((prev) => {
          const base = prev.launchKey === launchKey ? prev : createEmptyCache(launchKey);
          if (response.context.kind === "presets") {
            const byId = new Map<string, TelegramMiniAppPresetSummary>(
              response.context.presets.map((entry) => [entry.id, entry] as const),
            );
            return {
              ...base,
              presets: {
                status: response.context.provenance.status === "ok" ? "ok" : "unavailable",
                byId,
                expiresAtMs: provenanceExpiresAtMs(response.context.provenance, response.serverNowSec, receivedWallMs),
              },
            };
          }
          const depegById = new Map<string, TelegramMiniAppActiveDepeg>(
            response.context.activeDepegs.events.map((event) => [event.stablecoinId, event] as const),
          );
          const depegProvenance = response.context.activeDepegs.provenance;
          const depegExpiresAtMs = provenanceExpiresAtMs(depegProvenance, response.serverNowSec, receivedWallMs);
          const nextCoinsById = new Map(base.coinsById);
          for (const [id, signal] of Object.entries(response.context.coinSignals)) {
            nextCoinsById.set(id, {
              signal,
              depeg: depegById.get(id) ?? null,
              depegProvenance,
              expiresAtMs: minExpiryMs([
                depegExpiresAtMs,
                provenanceExpiresAtMs(signal.price.provenance, response.serverNowSec, receivedWallMs),
                provenanceExpiresAtMs(signal.dews.provenance, response.serverNowSec, receivedWallMs),
                provenanceExpiresAtMs(signal.safety.provenance, response.serverNowSec, receivedWallMs),
              ]),
            });
          }
          const nextHomeDepegLaneByKey = capturedKey.startsWith("home:")
            ? new Map(base.homeDepegLaneByKey).set(capturedHomeKey, {
                status: depegProvenance.status === "ok" ? "ok" : "unavailable",
                events: depegProvenance.status === "ok" ? response.context.activeDepegs.events : [],
                expiresAtMs: depegExpiresAtMs,
              })
            : base.homeDepegLaneByKey;
          return {
            ...base,
            coinsById: nextCoinsById,
            homeDepegLaneByKey: nextHomeDepegLaneByKey,
          };
        });
      })
      .catch((err) => {
        if (epochRef.current !== requestEpoch || activeLaunchKeyRef.current !== launchKey) return;
        if (isMiniAppVersionMismatch(err)) {
          if (!refreshMiniAppBundleOnce({
            contractVersion: err.serverContractVersion,
            catalogVersion: err.serverCatalogVersion,
          })) {
            onUpdateRequiredRef.current();
          }
          return;
        }
        if (err instanceof MiniAppRequestError && err.status === 401 && err.code === "stale-auth") {
          onSessionAuthExpiredRef.current();
          return;
        }
        if (err instanceof MiniAppRequestError && err.status === 429) {
          // Cooldown 429 must not permanently poison this launch: allow 1 cancellable retry per key.
          if (activeDesiredKeyRef.current !== capturedKey) return;
          if (!retriedKeysRef.current.has(capturedKey)) {
            retriedKeysRef.current.add(capturedKey);
            clearPendingRetry();
            const delayMs = (err.retryAfterSec ?? 1) * 1000 + 50;
            const timerId = window.setTimeout(() => {
              if (pendingRetryRef.current?.timerId === timerId) {
                pendingRetryRef.current = null;
              }
              if (
                epochRef.current !== requestEpoch
                || activeLaunchKeyRef.current !== launchKey
                || activeDesiredKeyRef.current !== capturedKey
              ) {
                return;
              }
              setRetryNonce((current) => current + 1);
            }, delayMs);
            pendingRetryRef.current = { key: capturedKey, timerId };
            return;
          }
        }
        setCache((prev) => {
          const base = prev.launchKey === launchKey ? prev : createEmptyCache(launchKey);
          if (capturedRequest.kind === "presets") {
            return { ...base, presets: { status: "unavailable", byId: EMPTY_PRESETS_MAP, expiresAtMs: null } };
          }
          if (capturedKey.startsWith("home:")) {
            const nextHome = new Map(base.homeDepegLaneByKey);
            nextHome.set(capturedHomeKey, { status: "unavailable", events: [], expiresAtMs: null });
            return { ...base, homeDepegLaneByKey: nextHome };
          }
          const nextFailed = new Set(base.failedCoinKeys);
          nextFailed.add(capturedKey);
          return { ...base, failedCoinKeys: nextFailed };
        });
      })
      .finally(() => {
        if (epochRef.current === requestEpoch) {
          inFlightKeysRef.current.delete(capturedKey);
        }
      });
  }, [clockMs, desired, enabled, homeCoinKey, initData, isCached, launchKey, retryNonce]);

  const homePegContext = useMemo<HomePegContext>(() => {
    if (!enabled || isNewUser || !homeCoinKey) return { status: "idle", events: [], truncated: false };
    const lane = activeCache.homeDepegLaneByKey.get(homeCoinKey);
    if (!lane || isExpiredEntry(lane.expiresAtMs, clockMs)) {
      return { status: "idle", events: [], truncated: homeTruncated };
    }
    return { status: lane.status, events: lane.events, truncated: homeTruncated };
  }, [activeCache, clockMs, enabled, homeCoinKey, homeTruncated, isNewUser]);

  const coinLiveContext = useMemo<CoinLiveContext>(() => {
    if (!enabled || !coinScreenId || !coinScreenSelectable) {
      return { status: "idle", signal: null, depeg: null, depegProvenance: null };
    }
    const cached = activeCache.coinsById.get(coinScreenId);
    if (cached && !isExpiredEntry(cached.expiresAtMs, clockMs)) {
      return {
        status: "ok",
        signal: cached.signal,
        depeg: cached.depeg,
        depegProvenance: cached.depegProvenance,
      };
    }
    if (activeCache.failedCoinKeys.has(`coin:${coinScreenId}`)) {
      return { status: "unavailable", signal: null, depeg: null, depegProvenance: null };
    }
    return { status: "idle", signal: null, depeg: null, depegProvenance: null };
  }, [activeCache, clockMs, coinScreenId, coinScreenSelectable, enabled]);

  const presetsLiveContext = useMemo<PresetsLiveContext>(() => {
    if (!enabled || !activeCache.presets || isExpiredEntry(activeCache.presets.expiresAtMs, clockMs)) {
      return { status: "idle", byId: EMPTY_PRESETS_MAP };
    }
    return { status: activeCache.presets.status, byId: activeCache.presets.byId };
  }, [activeCache, clockMs, enabled]);

  return { homePegContext, coinLiveContext, presetsLiveContext };
}
