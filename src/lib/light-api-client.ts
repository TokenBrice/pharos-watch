"use client";

import { apiFetch } from "@/lib/api";

export async function fetchLightApiJson<T>(path: string): Promise<T> {
  return apiFetch<T>(path);
}
