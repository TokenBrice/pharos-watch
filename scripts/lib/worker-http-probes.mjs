export function accessHeaders(args) {
  const headers = {};
  if (args.cfAccessClientId && args.cfAccessClientSecret) {
    headers["CF-Access-Client-Id"] = args.cfAccessClientId;
    headers["CF-Access-Client-Secret"] = args.cfAccessClientSecret;
  }
  return headers;
}

export async function fetchJsonProbe(args, path, origin = args.apiUrl) {
  const url = new URL(path, origin);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { method: "GET", headers: accessHeaders(args) });
    const text = await response.text();
    let payload = null;
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
  args,
  { includeHealth = true, includeStatus = false, includeStatusHistory = false } = {},
) {
  const probes = {};
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
