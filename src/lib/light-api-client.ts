"use client";

import { apiFetch } from "@/lib/api";
import type { FrontendApiQueryDescriptor } from "@/lib/api-query-runtime-registry";

export async function fetchLightApiJson<T>(descriptor: FrontendApiQueryDescriptor<T>): Promise<T> {
  return apiFetch(descriptor.path, descriptor.schema);
}
