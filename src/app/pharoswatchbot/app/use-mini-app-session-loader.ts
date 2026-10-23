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
  applyConfirmedSnapshot: (snapshot: TelegramMiniAppClientSnapshot) => void;
  setStatus: Dispatch<SetStateAction<MiniAppSessionStatusValue>>;
  setSessionMessage: Dispatch<SetStateAction<string | null>>;
  setSessionAuthExpired: Dispatch<SetStateAction<boolean>>;
};

/** Fetch the signed session snapshot; the terminal/state refs stay inside this hook so the shell can render from the returned callback. */
export function useMiniAppSessionLoader({
  terminalRef,
  stateRef,
  applyConfirmedSnapshot,
  setStatus,
  setSessionMessage,
  setSessionAuthExpired,
}: UseMiniAppSessionLoaderArgs) {
  return useCallback(async (nextInitData: string) => {
    if (terminalRef.current) return;
    setStatus("loading");
    try {
      const snapshot = await postMiniAppSnapshot(SESSION_ENDPOINT, { initData: nextInitData });
      if (terminalRef.current) return;
      applyConfirmedSnapshot(snapshot);
      setStatus("ready");
      setSessionMessage(null);
    } catch (err) {
      if (terminalRef.current) return;
      if (isMiniAppVersionMismatch(err) && refreshMiniAppBundleOnce({
        contractVersion: err.serverContractVersion,
        catalogVersion: err.serverCatalogVersion,
      })) {
        return;
      }
      if (err instanceof MiniAppRequestError && err.code === "stale-auth") setSessionAuthExpired(true);
      setStatus(stateRef.current ? "stale" : "error");
      setSessionMessage(miniAppErrorMessage(err, "session"));
    }
  }, [applyConfirmedSnapshot, setSessionAuthExpired, setSessionMessage, setStatus, stateRef, terminalRef]);
}
