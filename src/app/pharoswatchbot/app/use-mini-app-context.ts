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
}

interface LaunchContextCache {
  launchKey: string;
  coinsById: ReadonlyMap<string, CachedCoinEntry>;
  failedCoinKeys: ReadonlySet<string>;
  homeDepegLaneByKey: ReadonlyMap<string, { status: "ok" | "unavailable"; events: TelegramMiniAppActiveDepeg[] }>;
  presets: { status: "ok" | "unavailable"; byId: ReadonlyMap<string, TelegramMiniAppPresetSummary> } | null;
}

const EMPTY_PRESETS_MAP: ReadonlyMap<string, TelegramMiniAppPresetSummary> = new Map();

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
 * followed presets in resolver order.
 */
export function selectWatchedCoinIdsForContext(
  state: TelegramMiniAppState,
  limit = MAX_WATCHED_CONTEXT_COINS,
): string[] {
  const rankById = new Map<string, number>();
  for (const coin of state.catalog.searchableCoins) {
    rankById.set(coin.stablecoinId, coin.rank ?? Number.MAX_SAFE_INTEGER);
  }
  const picked: string[] = [];
  const seen = new Set<string>();
  const addIfSelectable = (stablecoinId: string) => {
    if (picked.length >= limit || seen.has(stablecoinId) || !rankById.has(stablecoinId)) return;
    seen.add(stablecoinId);
    picked.push(stablecoinId);
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
  return picked;
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
  const inFlightKeysRef = useRef<Set<string>>(new Set());
  const epochRef = useRef(0);
  const activeLaunchKeyRef = useRef(launchKey);
  const onSessionAuthExpiredRef = useRef(onSessionAuthExpired);
  const onUpdateRequiredRef = useRef(onUpdateRequired);

  useIsomorphicLayoutEffect(() => {
    onSessionAuthExpiredRef.current = onSessionAuthExpired;
    onUpdateRequiredRef.current = onUpdateRequired;
  });

  useEffect(() => {
    if (activeLaunchKeyRef.current !== launchKey) {
      activeLaunchKeyRef.current = launchKey;
      epochRef.current += 1;
      inFlightKeysRef.current.clear();
    }
  }, [launchKey]);

  const activeCache = cache.launchKey === launchKey ? cache : EMPTY_CACHE;

  const watchedCoinIds = useMemo(
    () => (state && !isNewUser ? selectWatchedCoinIdsForContext(state) : []),
    [isNewUser, state],
  );
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

  const isCached = useMemo(() => {
    if (!desired) return true;
    if (desired.request.kind === "presets") return activeCache.presets != null;
    if (desired.key.startsWith("coin:")) {
      const id = desired.request.stablecoinIds[0]!;
      return activeCache.coinsById.has(id) || activeCache.failedCoinKeys.has(desired.key);
    }
    return activeCache.homeDepegLaneByKey.has(homeCoinKey);
  }, [activeCache, desired, homeCoinKey]);

  useEffect(() => {
    if (!enabled || !desired || !launchKey || isCached) return;
    if (inFlightKeysRef.current.has(desired.key)) return;

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
              },
            };
          }
          const depegById = new Map<string, TelegramMiniAppActiveDepeg>(
            response.context.activeDepegs.events.map((event) => [event.stablecoinId, event] as const),
          );
          const depegProvenance = response.context.activeDepegs.provenance;
          const nextCoinsById = new Map(base.coinsById);
          for (const [id, signal] of Object.entries(response.context.coinSignals)) {
            nextCoinsById.set(id, {
              signal,
              depeg: depegById.get(id) ?? null,
              depegProvenance,
            });
          }
          const nextHomeDepegLaneByKey = capturedKey.startsWith("home:")
            ? new Map(base.homeDepegLaneByKey).set(capturedHomeKey, {
                status: depegProvenance.status === "ok" ? "ok" : "unavailable",
                events: depegProvenance.status === "ok" ? response.context.activeDepegs.events : [],
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
        setCache((prev) => {
          const base = prev.launchKey === launchKey ? prev : createEmptyCache(launchKey);
          if (capturedRequest.kind === "presets") {
            return { ...base, presets: { status: "unavailable", byId: EMPTY_PRESETS_MAP } };
          }
          if (capturedKey.startsWith("home:")) {
            const nextHome = new Map(base.homeDepegLaneByKey);
            nextHome.set(capturedHomeKey, { status: "unavailable", events: [] });
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
  }, [desired, enabled, homeCoinKey, initData, isCached, launchKey]);

  const homePegContext = useMemo<HomePegContext>(() => {
    if (!enabled || isNewUser || !homeCoinKey) return { status: "idle", events: [] };
    return activeCache.homeDepegLaneByKey.get(homeCoinKey) ?? { status: "idle", events: [] };
  }, [activeCache, enabled, homeCoinKey, isNewUser]);

  const coinLiveContext = useMemo<CoinLiveContext>(() => {
    if (!enabled || !coinScreenId || !coinScreenSelectable) {
      return { status: "idle", signal: null, depeg: null, depegProvenance: null };
    }
    const cached = activeCache.coinsById.get(coinScreenId);
    if (cached) {
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
  }, [activeCache, coinScreenId, coinScreenSelectable, enabled]);

  const presetsLiveContext = useMemo<PresetsLiveContext>(() => {
    if (!enabled || !activeCache.presets) {
      return { status: "idle", byId: EMPTY_PRESETS_MAP };
    }
    return activeCache.presets;
  }, [activeCache, enabled]);

  return { homePegContext, coinLiveContext, presetsLiveContext };
}
