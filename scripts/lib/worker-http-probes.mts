interface WorkerProbeArgs {
  apiUrl: string;
  adminApiUrl?: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
  apiKey?: string;
  timeoutMs?: number;
  noCache?: boolean;
}

interface WorkerHttpProbeResult {
  url: string;
  status: number;
  ok: boolean;
  latencyMs: number;
  payload?: unknown;
  /** Producer/update clock carried by the response, when the route publishes one. */
  updatedAt?: number | null;
  error?: string;
}

export function accessHeaders(args: WorkerProbeArgs): Record<string, string> {
  const headers: Record<string, string> = {};
  if (args.cfAccessClientId && args.cfAccessClientSecret) {
    headers["CF-Access-Client-Id"] = args.cfAccessClientId;
    headers["CF-Access-Client-Secret"] = args.cfAccessClientSecret;
  }
  if (args.apiKey) {
    headers["X-API-Key"] = args.apiKey;
  }
  if (args.noCache) {
    headers["Cache-Control"] = "no-cache";
  }
  return headers;
}

function readUpdatedAtHeader(response: Response): number | null {
  const raw = response.headers.get("X-Data-Updated-At");
  if (!raw || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

export async function fetchJsonProbe(
  args: WorkerProbeArgs,
  path: string,
  origin: string = args.apiUrl,
): Promise<WorkerHttpProbeResult> {
  const url = new URL(path, origin);
  const startedAt = Date.now();
  const signal = args.timeoutMs != null ? AbortSignal.timeout(args.timeoutMs) : undefined;
  try {
    const response = await fetch(url, { method: "GET", headers: accessHeaders(args), signal });
    const updatedAt = readUpdatedAtHeader(response);
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text.slice(0, 1000);
    }
    return {
      url: url.toString(),
      status: response.status,
      ok: response.ok,
      latencyMs: Date.now() - startedAt,
      payload,
      updatedAt,
    };
  } catch (error) {
    return {
      url: url.toString(),
      status: 0,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function collectWorkerHttpProbes(
  args: WorkerProbeArgs,
  {
    includeHealth = true,
    includeStatus = false,
    includeStatusHistory = false,
  }: { includeHealth?: boolean; includeStatus?: boolean; includeStatusHistory?: boolean } = {},
): Promise<Record<string, WorkerHttpProbeResult>> {
  const probes: Record<string, WorkerHttpProbeResult> = {};
  if (includeHealth) {
    probes.health = await fetchJsonProbe(args, "/api/health");
  }
  if (includeStatus) {
    probes.status = await fetchJsonProbe(args, "/api/status", args.adminApiUrl);
  }
  if (includeStatusHistory) {
    probes.statusHistory = await fetchJsonProbe(args, "/api/status-history", args.adminApiUrl);
  }
  return probes;
}
