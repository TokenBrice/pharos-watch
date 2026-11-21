import { z } from "zod";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { PUBLIC_API_CONTRACT_VERSION } from "@shared/lib/public-api-contract";
import { API_ORIGIN } from "@shared/lib/runtime-origins";
import { createEdgeCacheContext, readEdgeCache, writeEdgeCache } from "../handlers/http/edge-cache";
import { readRequestTextBounded } from "../lib/api-json-body";
import { jsonResponse } from "../lib/api-response";

const MCP_MAX_BODY_BYTES = 16 * 1024;
const SUPPORTED_MCP_PROTOCOL_VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
] as const;
const DEFAULT_NEGOTIATED_PROTOCOL_VERSION = "2025-11-25";
const DEFAULT_ASSUMED_HEADER_VERSION = "2025-03-26";
const SUPPORTED_VERSION_SET = new Set<string>(SUPPORTED_MCP_PROTOCOL_VERSIONS);

const MCP_INSTRUCTIONS =
  "Pharos stablecoin risk, compliance, and contract-resolution server. All tools are read-only and preserve response freshness metadata (_meta and _transport headers). Prefer get_risk_check for multi-signal pre-trade or mandate checks and resolve_stablecoin to map on-chain addresses to canonical Pharos IDs.";

const NO_STORE_JSON_HEADERS = {
  "Cache-Control": "no-store",
};

const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

interface McpToolManifestEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: typeof READ_ONLY_TOOL_ANNOTATIONS;
}

const MCP_TOOLS: readonly McpToolManifestEntry[] = [
  {
    name: "resolve_stablecoin",
    description:
      "Resolve a contract address (with or without chain), a batch of chain:address tuples, a canonical Pharos ID, or a CoinGecko ID to Pharos stablecoin identities and deployments.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        chain: { type: "string", description: "Canonical chain ID, alias, numeric EVM ID, or CAIP-2 eip155:<id>." },
        address: { type: "string", description: "On-chain contract address." },
        id: { type: "string", description: "Canonical Pharos stablecoin ID (for example usdc-circle)." },
        geckoId: { type: "string", description: "CoinGecko ID (for example usd-coin)." },
        contracts: {
          type: "array",
          items: { type: "string" },
          maxItems: 50,
          description: "Batch of chain:address tuples (up to 50).",
        },
      },
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
  },
  {
    name: "get_risk_check",
    description:
      "Fetch a unified risk-gate snapshot for up to 25 stablecoins by canonical ID or chain:address contract: Safety Score and pillars, DEWS, peg/depeg state, DDR outlook, DEX liquidity, redemption backstop, freeze controls, and MiCA/GENIUS compliance.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          maxItems: 25,
          description: "Canonical Pharos stablecoin IDs (for example ['usdc-circle', 'usdt-tether']).",
        },
        contracts: {
          type: "array",
          items: { type: "string" },
          maxItems: 25,
          description: "Chain:address tuples (for example ['ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48']).",
        },
      },
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
  },
  {
    name: "get_compliance",
    description:
      "Read structured EU MiCA and U.S. GENIUS Act compliance assessments for one canonical stablecoin ID or across the tracked stablecoin registry with optional filters.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", description: "Optional canonical Pharos stablecoin ID for a single-coin dossier." },
        regime: { type: "string", enum: ["mica", "genius", "all"] },
        micaStatus: { type: "string" },
        geniusStatus: { type: "string" },
        tokenType: { type: "string", enum: ["EMT", "ART"] },
        peg: { type: "string", description: "Peg currency code (for example USD or EUR)." },
        includePreLaunch: { type: "boolean" },
      },
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
  },
  {
    name: "get_safety_report_card",
    description:
      "Fetch the compact Safety Score V9 report card detail for one canonical stablecoin ID, including pillar scores, evidence, and publication freshness.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["stablecoin"],
      properties: {
        stablecoin: { type: "string", description: "Canonical Pharos stablecoin ID (for example usdc-circle)." },
      },
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
  },
  {
    name: "get_depeg_events",
    description:
      "Fetch active or historical depeg incidents with bounded pagination (default 20, max 50 rows per call).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        stablecoin: { type: "string", description: "Optional canonical Pharos stablecoin ID filter." },
        active: { type: "boolean", description: "When true, return only currently active depeg incidents." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Max rows to return (default 20, max 50)." },
        cursor: { type: "string", description: "Opaque pagination cursor from a previous call." },
        includePending: { type: "boolean", description: "Include pending unconfirmed incidents." },
      },
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
  },
  {
    name: "get_stress_signals",
    description:
      "Fetch DEWS early-warning stress signals for the stablecoin universe or one stablecoin with bounded history.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        stablecoin: { type: "string", description: "Optional canonical Pharos stablecoin ID." },
        days: { type: "integer", minimum: 1, maximum: 90, description: "History window in days when stablecoin is set (default 7, max 90)." },
      },
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
  },
  {
    name: "get_stablecoin_reserves",
    description:
      "Fetch live or reviewed reserve composition and provenance for a live-reserve-enabled stablecoin.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["stablecoin"],
      properties: {
        stablecoin: { type: "string", description: "Canonical Pharos stablecoin ID." },
      },
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
  },
];

const ResolveToolArgsSchema = z.object({
  chain: z.string().trim().min(1).optional(),
  address: z.string().trim().min(1).optional(),
  id: z.string().trim().min(1).optional(),
  geckoId: z.string().trim().min(1).optional(),
  contracts: z.array(z.string().trim().min(1)).max(50).optional(),
}).strict();

const RiskCheckToolArgsSchema = z.object({
  ids: z.array(z.string().trim().min(1)).max(25).optional(),
  contracts: z.array(z.string().trim().min(1)).max(25).optional(),
}).strict();

const ComplianceToolArgsSchema = z.object({
  id: z.string().trim().min(1).optional(),
  regime: z.enum(["mica", "genius", "all"]).optional(),
  micaStatus: z.string().trim().min(1).optional(),
  geniusStatus: z.string().trim().min(1).optional(),
  tokenType: z.enum(["EMT", "ART"]).optional(),
  peg: z.string().trim().min(1).optional(),
  includePreLaunch: z.boolean().optional(),
}).strict();

const SafetyReportCardToolArgsSchema = z.object({
  stablecoin: z.string().trim().min(1),
}).strict();

const DepegEventsToolArgsSchema = z.object({
  stablecoin: z.string().trim().min(1).optional(),
  active: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional(),
  cursor: z.string().trim().min(1).optional(),
  includePending: z.boolean().optional(),
}).strict();

const StressSignalsToolArgsSchema = z.object({
  stablecoin: z.string().trim().min(1).optional(),
  days: z.number().int().min(1).max(90).optional(),
}).strict();

const StablecoinReservesToolArgsSchema = z.object({
  stablecoin: z.string().trim().min(1),
}).strict();

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

function jsonRpcResult(id: string | number | null, result: unknown, status = 200): Response {
  return jsonResponse({ jsonrpc: "2.0", id, result }, { status, headers: NO_STORE_JSON_HEADERS });
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  status = 200,
): Response {
  return jsonResponse(
    { jsonrpc: "2.0", id, error: { code, message } },
    { status, headers: NO_STORE_JSON_HEADERS },
  );
}

function canUseEdgeCache(): boolean {
  return typeof caches !== "undefined" && typeof caches?.default?.match === "function";
}

async function runCachedRestTool(
  restPathWithQuery: string,
  execCtx: ExecutionContext | undefined,
  invokeHandler: (url: URL) => Promise<Response>,
): Promise<Response> {
  const syntheticUrl = new URL(restPathWithQuery, API_ORIGIN);
  const syntheticRequest = new Request(syntheticUrl.toString(), { method: "GET" });
  const useCache = canUseEdgeCache();
  const edgeCache = useCache ? createEdgeCacheContext(syntheticRequest, syntheticUrl) : null;

  if (edgeCache) {
    try {
      const cached = await readEdgeCache(edgeCache);
      if (cached) return cached;
    } catch {
      // Cache lookup failures never break tool execution.
    }
  }

  const response = await invokeHandler(syntheticUrl);

  if (edgeCache && execCtx && response.status === 200) {
    try {
      writeEdgeCache(edgeCache, response, execCtx);
    } catch {
      // Best-effort cache write.
    }
  }

  return response;
}

async function formatToolResponse(id: string | number | null, restResponse: Response): Promise<Response> {
  const rawText = await restResponse.text();
  let parsed: unknown = rawText;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    // Non-JSON body stays as text.
  }

  const transportMeta: Record<string, unknown> = {
    httpStatus: restResponse.status,
  };
  const headerMap: readonly [string, string][] = [
    ["X-Safety-Score-Status", "safetyScoreStatus"],
    ["X-Safety-Score-Generation", "safetyScoreGeneration"],
    ["X-Data-Updated-At", "dataUpdatedAt"],
    ["X-Data-Age", "dataAge"],
    ["X-Data-Freshness", "dataFreshness"],
    ["Warning", "warning"],
  ];
  for (const [headerName, fieldName] of headerMap) {
    const val = restResponse.headers.get(headerName);
    if (val !== null) transportMeta[fieldName] = val;
  }

  const structuredContent = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? { ...(parsed as Record<string, unknown>), _transport: transportMeta }
    : { data: parsed, _transport: transportMeta };

  return jsonRpcResult(id, {
    content: [{ type: "text", text: typeof parsed === "string" ? parsed : JSON.stringify(parsed) }],
    structuredContent,
    _meta: transportMeta,
    isError: !restResponse.ok,
  });
}

function invalidToolArgsResponse(id: string | number | null, detail: string): Response {
  return jsonRpcResult(id, {
    content: [{ type: "text", text: JSON.stringify({ error: detail }) }],
    isError: true,
  });
}

async function executeToolCall(
  db: D1Database,
  execCtx: ExecutionContext | undefined,
  id: string | number | null,
  toolName: string,
  rawArgs: unknown,
): Promise<Response> {
  const argsInput = rawArgs ?? {};

  switch (toolName) {
    case "resolve_stablecoin": {
      const parsed = ResolveToolArgsSchema.safeParse(argsInput);
      if (!parsed.success) return invalidToolArgsResponse(id, parsed.error.issues[0]?.message ?? "Invalid arguments");
      const query = API_PATHS.resolve({
        chain: parsed.data.chain,
        address: parsed.data.address,
        id: parsed.data.id,
        geckoId: parsed.data.geckoId,
        contracts: parsed.data.contracts?.length ? parsed.data.contracts.join(",") : undefined,
      });
      const res = await runCachedRestTool(query, execCtx, async (url) => {
        const { handleResolve } = await import("./resolve");
        return handleResolve(url);
      });
      return formatToolResponse(id, res);
    }

    case "get_risk_check": {
      const parsed = RiskCheckToolArgsSchema.safeParse(argsInput);
      if (!parsed.success) return invalidToolArgsResponse(id, parsed.error.issues[0]?.message ?? "Invalid arguments");
      const query = API_PATHS.riskCheck({
        ids: parsed.data.ids,
        contracts: parsed.data.contracts,
      });
      const res = await runCachedRestTool(query, execCtx, async (url) => {
        const { handleRiskCheck } = await import("./risk-check");
        return handleRiskCheck(db, url);
      });
      return formatToolResponse(id, res);
    }

    case "get_compliance": {
      const parsed = ComplianceToolArgsSchema.safeParse(argsInput);
      if (!parsed.success) return invalidToolArgsResponse(id, parsed.error.issues[0]?.message ?? "Invalid arguments");
      if (parsed.data.id) {
        const coinId = parsed.data.id;
        const path = API_PATHS.complianceCoin(coinId);
        const res = await runCachedRestTool(path, execCtx, async () => {
          const { handleComplianceCoin } = await import("./compliance");
          return handleComplianceCoin(coinId);
        });
        return formatToolResponse(id, res);
      }
      const query = API_PATHS.compliance({
        regime: parsed.data.regime,
        micaStatus: parsed.data.micaStatus,
        geniusStatus: parsed.data.geniusStatus,
        tokenType: parsed.data.tokenType,
        peg: parsed.data.peg,
        includePreLaunch: parsed.data.includePreLaunch,
      });
      const res = await runCachedRestTool(query, execCtx, async (url) => {
        const { handleCompliance } = await import("./compliance");
        return handleCompliance(url);
      });
      return formatToolResponse(id, res);
    }

    case "get_safety_report_card": {
      const parsed = SafetyReportCardToolArgsSchema.safeParse(argsInput);
      if (!parsed.success) return invalidToolArgsResponse(id, parsed.error.issues[0]?.message ?? "Invalid arguments");
      const query = API_PATHS.reportCardsV9Detail(parsed.data.stablecoin);
      const res = await runCachedRestTool(query, execCtx, async (url) => {
        const { handleReportCardsV9Detail } = await import("./report-cards-v9-projections");
        return handleReportCardsV9Detail(db, url);
      });
      return formatToolResponse(id, res);
    }

    case "get_depeg_events": {
      const parsed = DepegEventsToolArgsSchema.safeParse(argsInput);
      if (!parsed.success) return invalidToolArgsResponse(id, parsed.error.issues[0]?.message ?? "Invalid arguments");
      const query = API_PATHS.depegEvents({
        stablecoinId: parsed.data.stablecoin,
        active: parsed.data.active,
        limit: parsed.data.limit ?? 20,
        cursor: parsed.data.cursor,
        includePending: parsed.data.includePending,
      });
      const res = await runCachedRestTool(query, execCtx, async (url) => {
        const { handleDepegEvents } = await import("./depeg-events");
        return handleDepegEvents(db, url);
      });
      return formatToolResponse(id, res);
    }

    case "get_stress_signals": {
      const parsed = StressSignalsToolArgsSchema.safeParse(argsInput);
      if (!parsed.success) return invalidToolArgsResponse(id, parsed.error.issues[0]?.message ?? "Invalid arguments");
      const query = API_PATHS.stressSignals(
        parsed.data.stablecoin,
        parsed.data.stablecoin ? (parsed.data.days ?? 7) : undefined,
      );
      const res = await runCachedRestTool(query, execCtx, async (url) => {
        const { handleStressSignals } = await import("./stress-signals");
        return handleStressSignals(db, url);
      });
      return formatToolResponse(id, res);
    }

    case "get_stablecoin_reserves": {
      const parsed = StablecoinReservesToolArgsSchema.safeParse(argsInput);
      if (!parsed.success) return invalidToolArgsResponse(id, parsed.error.issues[0]?.message ?? "Invalid arguments");
      const coinId = parsed.data.stablecoin;
      const path = API_PATHS.stablecoinReserves(coinId);
      const res = await runCachedRestTool(path, execCtx, async () => {
        const { handleStablecoinReserves } = await import("./stablecoin-reserves");
        return handleStablecoinReserves(db, coinId);
      });
      return formatToolResponse(id, res);
    }

    default:
      return jsonRpcError(id, -32602, `Unknown tool: ${toolName}`);
  }
}

export async function handleMcp(
  db: D1Database,
  request: Request,
  execCtx?: ExecutionContext,
): Promise<Response> {
  const rawBody = await readRequestTextBounded(request, MCP_MAX_BODY_BYTES, {
    bodyTooLargeMessage: "MCP request body exceeds 16 KiB limit",
    responseOptions: { noStore: true },
  });
  if (rawBody instanceof Response) return rawBody;

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    return jsonRpcError(null, -32700, "Parse error: request body must be valid JSON", 400);
  }

  if (Array.isArray(decoded)) {
    return jsonRpcError(null, -32600, "Invalid Request: JSON-RPC batch arrays are not supported", 400);
  }

  const parsedRpc = JsonRpcRequestSchema.safeParse(decoded);
  if (!parsedRpc.success) {
    return jsonRpcError(null, -32600, "Invalid Request: expected JSON-RPC 2.0 object", 400);
  }

  const rpc = parsedRpc.data;
  const hasId = Object.prototype.hasOwnProperty.call(decoded as Record<string, unknown>, "id");

  // Validate MCP-Protocol-Version header on every request after initialize.
  if (rpc.method !== "initialize") {
    const headerVersion = request.headers.get("MCP-Protocol-Version")?.trim() || DEFAULT_ASSUMED_HEADER_VERSION;
    if (!SUPPORTED_VERSION_SET.has(headerVersion)) {
      return jsonRpcError(
        hasId ? (rpc.id ?? null) : null,
        -32600,
        `Unsupported MCP-Protocol-Version: ${headerVersion}. Supported versions: ${SUPPORTED_MCP_PROTOCOL_VERSIONS.join(", ")}`,
        400,
      );
    }
  }

  // Notifications have no id and receive 202 Accepted with an empty body.
  if (!hasId) {
    return new Response(null, { status: 202, headers: NO_STORE_JSON_HEADERS });
  }

  const requestId = rpc.id ?? null;

  switch (rpc.method) {
    case "initialize": {
      const requestedVersion =
        rpc.params && typeof rpc.params === "object" && !Array.isArray(rpc.params)
          ? (rpc.params as { protocolVersion?: unknown }).protocolVersion
          : undefined;
      const protocolVersion =
        typeof requestedVersion === "string" && SUPPORTED_VERSION_SET.has(requestedVersion)
          ? requestedVersion
          : DEFAULT_NEGOTIATED_PROTOCOL_VERSION;
      return jsonRpcResult(requestId, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: {
          name: "pharos",
          version: PUBLIC_API_CONTRACT_VERSION,
        },
        instructions: MCP_INSTRUCTIONS,
      });
    }

    case "ping":
      return jsonRpcResult(requestId, {});

    case "tools/list":
      return jsonRpcResult(requestId, { tools: MCP_TOOLS });

    case "tools/call": {
      const callParams = z.object({
        name: z.string().min(1),
        arguments: z.unknown().optional(),
      }).safeParse(rpc.params);
      if (!callParams.success) {
        return jsonRpcError(requestId, -32602, "Invalid params: expected { name, arguments? }");
      }
      return executeToolCall(db, execCtx, requestId, callParams.data.name, callParams.data.arguments);
    }

    default:
      return jsonRpcError(requestId, -32601, `Method not found: ${rpc.method}`);
  }
}
