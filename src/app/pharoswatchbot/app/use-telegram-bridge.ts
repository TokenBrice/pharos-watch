"use client";

import { useEffect, useState } from "react";
import {
  applyTelegramTheme,
  bindTelegramViewportAndTheme,
  getTelegramLaunchContext,
  type TelegramWebAppSdk,
} from "./telegram-sdk";

/** Inside Telegram, poll for up to 8s (160 × 50ms) while Telegram's launch initData settles on slow clients. */
const TELEGRAM_LAUNCH_MAX_ATTEMPTS = 160;
/** Delay between Telegram launch-context polls; 50ms keeps the spin tight without busy-looping. */
const TELEGRAM_LAUNCH_RETRY_MS = 50;

export type TelegramBridgeStatus = "loading" | "ready" | "preview" | "missing";

export interface TelegramBridgeState {
  /** The Telegram WebApp SDK handle once probing has resolved. It can exist in standalone browser preview. */
  webApp: TelegramWebAppSdk | null;
  /** Signed launch authorization payload. Empty string in browser preview. */
  initData: string;
  /** Raw `start_param` from launch context. Null when absent. */
  startParam: string | null;
  /** Preview user name (from `initDataUnsafe.user`) used by the browser preview surface. */
  previewName: string | null;
  /** Resolution status:
   * - `loading`: still probing for `window.Telegram.WebApp`.
   * - `ready`: bridge resolved with valid `initData`.
   * - `preview`: no Telegram launch hint detected — browser preview mode.
   * - `missing`: launch hint detected but `initData` never arrived (e.g. Telegram bug/race).
   */
  status: TelegramBridgeStatus;
}

export interface UseTelegramBridgeOptions {
  /** Click handler attached to the Telegram BackButton while a non-home view or insight panel is shown. */
  onBack?: () => void;
  /** Whether the BackButton should be visible. The hook attaches `onBack` only while this is true. */
  backButtonVisible?: boolean;
  /** Click handler attached to the Telegram SettingsButton (always visible when the bridge exposes it). */
  onSettings?: () => void;
}

/**
 * Manages the Telegram WebApp bridge lifecycle for the Pharos Mini App.
 *
 * The hook encapsulates:
 * - WebApp probing (with browser-preview / in-Telegram retry budgets)
 * - Theme + viewport variable binding (delegated to `telegram-sdk`)
 * - BackButton attach/detach (conditional on `backButtonVisible`)
 * - SettingsButton attach/detach (always while a handler is provided)
 *
 * Post-mutation flows (requestWriteAccess, checkHomeScreenStatus) remain in
 * `client.tsx` because they depend on mutation lifecycle state captured at
 * call time — the bridge hook only exposes the steady-state surface.
 */
export function useTelegramBridge(opts: UseTelegramBridgeOptions = {}): TelegramBridgeState {
  const { onBack, backButtonVisible, onSettings } = opts;
  const [webApp, setWebApp] = useState<TelegramWebAppSdk | null>(null);
  const [initData, setInitData] = useState("");
  const [startParam, setStartParam] = useState<string | null>(null);
  const [previewName, setPreviewName] = useState<string | null>(null);
  const [status, setStatus] = useState<TelegramBridgeStatus>("loading");

  // Probe the Telegram launch context with a bounded retry loop, then bind theme/viewport.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cleanup = () => {};
    let attempts = 0;

    const initialize = () => {
      const launch = getTelegramLaunchContext();
      const shouldKeepWaiting = !launch.initData
        && launch.hasTelegramLaunchHint
        && attempts < TELEGRAM_LAUNCH_MAX_ATTEMPTS;
      if (shouldKeepWaiting) {
        attempts += 1;
        timer = setTimeout(initialize, TELEGRAM_LAUNCH_RETRY_MS);
        return;
      }
      if (cancelled) return;
      setWebApp(launch.webApp);
      setInitData(launch.initData);
      setStartParam(launch.startParam);
      setPreviewName(launch.previewName);
      applyTelegramTheme(launch.webApp);
      cleanup = bindTelegramViewportAndTheme(launch.webApp);
      launch.webApp?.ready?.();
      launch.webApp?.expand?.();
      if (launch.initData) {
        setStatus("ready");
      } else if (launch.hasTelegramLaunchHint) {
        setStatus("missing");
      } else {
        setStatus("preview");
      }
    };

    initialize();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      cleanup();
    };
  }, []);

  // BackButton lifecycle: show + attach handler when visible, hide + detach otherwise.
  useEffect(() => {
    const bb = webApp?.BackButton;
    if (!bb) return;
    if (!backButtonVisible || !onBack) {
      bb.hide?.();
      return;
    }
    const handler = onBack;
    bb.show?.();
    bb.onClick?.(handler);
    return () => {
      bb.offClick?.(handler);
      bb.hide?.();
    };
  }, [backButtonVisible, onBack, webApp]);

  // SettingsButton lifecycle: show + attach while a handler is provided.
  useEffect(() => {
    const sb = webApp?.SettingsButton;
    if (!sb || !onSettings) return;
    const handler = onSettings;
    sb.onClick?.(handler);
    sb.show?.();
    return () => {
      sb.offClick?.(handler);
      sb.hide?.();
    };
  }, [onSettings, webApp]);

  return { webApp, initData, startParam, previewName, status };
}
