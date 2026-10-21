/**
 * Packed watchlist row state used by the Mini App bulk watchlist editor and
 * its preview/undo fingerprints. Each row packs to `<id>~<base36 bitfield>`.
 */

import { TELEGRAM_MINI_APP_CATALOG_VERSION } from "@shared/lib/telegram-mini-app-catalog";

const DIRECT_PACK_MAX = 0x3ffff;

export const WATCHLIST_REGISTRY_VERSION = TELEGRAM_MINI_APP_CATALOG_VERSION;

export interface WatchlistDirectState {
  stablecoinId: string;
  alertDews: boolean;
  alertDepeg: boolean;
  alertSafety: boolean;
  alertLaunch: boolean;
  alertReserve: boolean;
  alertFreeze?: boolean;
  overrideDews: boolean;
  overrideDepeg: boolean;
  overrideSafety: boolean;
  overrideLaunch: boolean;
  overrideReserve: boolean;
  overrideFreeze?: boolean;
  dewsMinBand: "ALERT" | "WARNING" | "DANGER" | null;
  safetyMode: "all" | "downgrade-only" | "upgrade-only" | null;
  depegWorseningBpsStep: 100 | 250 | 500 | null;
}

export interface WatchlistPresetState {
  presetId: string;
  alertDews: boolean;
  alertDepeg: boolean;
  alertSafety: boolean;
  depegWorseningBpsStep: 100 | 250 | 500 | null;
}

export interface WatchlistState {
  registryVersion: string;
  direct: WatchlistDirectState[];
  presets: WatchlistPresetState[];
}

function bit(value: boolean, position: number): number {
  return value ? (1 << position) : 0;
}

function encodeDewsBand(value: WatchlistDirectState["dewsMinBand"]): number {
  return value === "ALERT" ? 1 : value === "WARNING" ? 2 : value === "DANGER" ? 3 : 0;
}

function decodeDewsBand(value: number): WatchlistDirectState["dewsMinBand"] {
  return value === 1 ? "ALERT" : value === 2 ? "WARNING" : value === 3 ? "DANGER" : null;
}

function encodeSafetyMode(value: WatchlistDirectState["safetyMode"]): number {
  return value === "all" ? 1 : value === "downgrade-only" ? 2 : value === "upgrade-only" ? 3 : 0;
}

function decodeSafetyMode(value: number): WatchlistDirectState["safetyMode"] {
  return value === 1 ? "all" : value === 2 ? "downgrade-only" : value === 3 ? "upgrade-only" : null;
}

function encodeDepegStep(value: 100 | 250 | 500 | null): number {
  return value === 100 ? 1 : value === 250 ? 2 : value === 500 ? 3 : 0;
}

function decodeDepegStep(value: number): 100 | 250 | 500 | null {
  return value === 1 ? 100 : value === 2 ? 250 : value === 3 ? 500 : null;
}

export function packWatchlistDirectState(row: WatchlistDirectState): string {
  const packed = bit(row.alertDews, 0)
    | bit(row.alertDepeg, 1)
    | bit(row.alertSafety, 2)
    | bit(row.alertLaunch, 3)
    | bit(row.alertReserve, 4)
    | bit(Boolean(row.alertFreeze), 16)
    | bit(row.overrideDews, 5)
    | bit(row.overrideDepeg, 6)
    | bit(row.overrideSafety, 7)
    | bit(row.overrideLaunch, 8)
    | bit(row.overrideReserve, 9)
    | bit(Boolean(row.overrideFreeze), 17)
    | (encodeDewsBand(row.dewsMinBand) << 10)
    | (encodeSafetyMode(row.safetyMode) << 12)
    | (encodeDepegStep(row.depegWorseningBpsStep) << 14);
  return `${row.stablecoinId}~${packed.toString(36)}`;
}

function splitPacked(value: string, max: number): { id: string; packed: number } | null {
  if (value.length > 160) return null;
  const separator = value.lastIndexOf("~");
  if (separator <= 0 || separator === value.length - 1) return null;
  const id = value.slice(0, separator);
  const encoded = value.slice(separator + 1);
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(id) || !/^[0-9a-z]+$/.test(encoded)) return null;
  const packed = Number.parseInt(encoded, 36);
  if (!Number.isSafeInteger(packed) || packed < 0 || packed > max) return null;
  return { id, packed };
}

export function unpackWatchlistDirectState(value: string): WatchlistDirectState | null {
  const decoded = splitPacked(value, DIRECT_PACK_MAX);
  if (!decoded) return null;
  const { id, packed } = decoded;
  return {
    stablecoinId: id,
    alertDews: Boolean(packed & (1 << 0)),
    alertDepeg: Boolean(packed & (1 << 1)),
    alertSafety: Boolean(packed & (1 << 2)),
    alertLaunch: Boolean(packed & (1 << 3)),
    alertReserve: Boolean(packed & (1 << 4)),
    alertFreeze: Boolean(packed & (1 << 16)),
    overrideDews: Boolean(packed & (1 << 5)),
    overrideDepeg: Boolean(packed & (1 << 6)),
    overrideSafety: Boolean(packed & (1 << 7)),
    overrideLaunch: Boolean(packed & (1 << 8)),
    overrideReserve: Boolean(packed & (1 << 9)),
    overrideFreeze: Boolean(packed & (1 << 17)),
    dewsMinBand: decodeDewsBand((packed >> 10) & 0x3),
    safetyMode: decodeSafetyMode((packed >> 12) & 0x3),
    depegWorseningBpsStep: decodeDepegStep((packed >> 14) & 0x3),
  };
}
