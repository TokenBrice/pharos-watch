"use client";

import { PHAROS_WEB_ACCEPT_MARKER } from "@shared/lib/request-source-marker";
import { buildRequestUrl } from "@/lib/api-url";
import type { FrontendApiQueryDescriptor } from "@/lib/api-query-runtime-registry";

class LightApiFetchError extends Error {
  constructor(path: string, status: number) {
    super(`Failed to fetch ${path}: ${status}`);
    this.name = "LightApiFetchError";
  }
}

export async function fetchLightApiJson<T>(descriptor: FrontendApiQueryDescriptor<T>): Promise<T> {
  const response = await fetch(buildRequestUrl(descriptor.path), {
    headers: {
      Accept: `application/json, ${PHAROS_WEB_ACCEPT_MARKER}`,
    },
  });
  if (!response.ok) {
    throw new LightApiFetchError(descriptor.path, response.status);
  }
  return response.json() as Promise<T>;
}
