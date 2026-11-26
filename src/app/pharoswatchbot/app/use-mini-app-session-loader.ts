"use client";

import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { miniAppErrorMessage, MiniAppRequestError } from "./error-messages";
import {
  isMiniAppVersionMismatch,
  postMiniAppSnapshot,
  refreshMiniAppBundleOnce,
  type TelegramMiniAppClientSnapshot,
} from "./mini-app-api";
import type { MiniAppSessionStatus as MiniAppSessionStatusValue } from "./components/MiniAppSessionStatus";
import type { TelegramMiniAppState } from "./types";

const SESSION_ENDPOINT = API_PATHS.telegramMiniAppSession();

type UseMiniAppSessionLoaderArgs = {
  terminalRef: RefObject<boolean>;
  stateRef: RefObject<TelegramMiniAppState | null>;
  beginSnapshotEpoch: () => number;
  isCurrentSnapshotEpoch: (epoch: number) => boolean;
  applyConfirmedSnapshot: (snapshot: TelegramMiniAppClientSnapshot, readEpoch?: number) => boolean;
  setStatus: Dispatch<SetStateAction<MiniAppSessionStatusValue>>;
  setSessionMessage: Dispatch<SetStateAction<string | null>>;
  setSessionAuthExpired: Dispatch<SetStateAction<boolean>>;
  setUpdateRequired: Dispatch<SetStateAction<boolean>>;
};

/** Fetch the signed session snapshot; monotonic epochs prevent stale reads from overwriting newer confirmed writes. */
export function useMiniAppSessionLoader({
  terminalRef,
  stateRef,
  beginSnapshotEpoch,
  isCurrentSnapshotEpoch,
  applyConfirmedSnapshot,
  setStatus,
  setSessionMessage,
  setSessionAuthExpired,
  setUpdateRequired,
}: UseMiniAppSessionLoaderArgs) {
  return useCallback(async (nextInitData: string) => {
    if (terminalRef.current) return;
    const epoch = beginSnapshotEpoch();
    setStatus("loading");
    try {
      const snapshot = await postMiniAppSnapshot(SESSION_ENDPOINT, { initData: nextInitData });
      if (terminalRef.current || !isCurrentSnapshotEpoch(epoch)) return;
      if (!applyConfirmedSnapshot(snapshot, epoch)) return;
      setStatus("ready");
      setSessionMessage(null);
    } catch (err) {
      if (terminalRef.current || !isCurrentSnapshotEpoch(epoch)) return;
      if (isMiniAppVersionMismatch(err)) {
        if (refreshMiniAppBundleOnce({
          contractVersion: err.serverContractVersion,
          catalogVersion: err.serverCatalogVersion,
        })) {
          return;
        }
        setUpdateRequired(true);
        setSessionMessage(null);
        return;
      }
      if (err instanceof MiniAppRequestError && err.code === "stale-auth") setSessionAuthExpired(true);
      setStatus(stateRef.current ? "stale" : "error");
      setSessionMessage(miniAppErrorMessage(err, "session"));
    }
  }, [
    applyConfirmedSnapshot,
    beginSnapshotEpoch,
    isCurrentSnapshotEpoch,
    setSessionAuthExpired,
    setSessionMessage,
    setStatus,
    setUpdateRequired,
    stateRef,
    terminalRef,
  ]);
}
