"use client";

import { PHAROS_WEB_ACCEPT_MARKER } from "@shared/lib/request-source-marker";
import { isSiteDataUiHostname, resolvePublicApiBase } from "@shared/lib/runtime-origins";

function getBrowserHostname(): string | null {
  return typeof window !== "undefined" ? window.location.hostname : null;
}

function buildSiteDataPath(path: string): string {
  return `/_site-data${path.slice("/api".length)}`;
}

function buildLightApiUrl(path: string): string {
  const hostname = getBrowserHostname();
  const envBase = process.env.NEXT_PUBLIC_API_BASE;
  if (!(envBase ?? "").trim() && hostname && isSiteDataUiHostname(hostname)) {
    return buildSiteDataPath(path);
  }
  return `${resolvePublicApiBase(hostname, envBase)}${path}`;
}

export async function fetchLightApiJson<T>(path: string): Promise<T> {
  const res = await fetch(buildLightApiUrl(path), {
    headers: {
      Accept: `application/json, ${PHAROS_WEB_ACCEPT_MARKER}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch ${path}: ${res.status}`);
  }
  return res.json() as Promise<T>;
}
