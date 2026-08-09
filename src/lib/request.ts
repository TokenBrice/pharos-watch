import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { formatSchemaLikeIssues, resolveSchemaLike, type SchemaLikeSource } from "@/lib/schema-like";
import { normalizeRequestTimeoutMs, resolveRequestSignal } from "@/lib/request-lifecycle";

export type RequestFailureKind = "http" | "network" | "timeout" | "aborted" | "superseded" | "parse" | "schema";

export class RequestFailure extends Error {
  readonly kind: RequestFailureKind;
  readonly url: string;
  readonly status: number | null;
  readonly bodyText: string | null;

  constructor(
    kind: RequestFailureKind,
    url: string,
    message: string,
    options: { status?: number | null; bodyText?: string | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RequestFailure";
    this.kind = kind;
    this.url = url;
    this.status = options.status ?? null;
    this.bodyText = options.bodyText ?? null;
  }
}

export interface RequestLifecycleOptions {
  init?: RequestInit;
  signal?: AbortSignal;
  timeoutMs?: number | null;
  allowHttpError?: boolean;
}

export interface RequestJsonOptions<T> extends RequestLifecycleOptions {
  schema?: SchemaLikeSource<T>;
}

export interface RequestResult<T> {
  data: T;
  response: Response;
}

function inputLabel(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

async function executeRequest<T>(
  input: RequestInfo | URL,
  options: RequestLifecycleOptions,
  readSuccessBody: (response: Response) => Promise<T>,
): Promise<RequestResult<T>> {
  const url = inputLabel(input);
  const parent = resolveRequestSignal(options.init?.signal, options.signal, "compose");
  const parentSignal = parent.signal;
  const timeoutMs = normalizeRequestTimeoutMs(options.timeoutMs);
  const timeout =
    timeoutMs == null
      ? null
      : createTimeoutSignal({
          timeoutMs,
          timeoutReason: new DOMException(`Request timed out after ${timeoutMs}ms`, "TimeoutError"),
          parentSignal,
        });
  const signal = timeout?.signal ?? parentSignal;

  try {
    const response = await fetch(input, { ...options.init, signal });
    if (!response.ok && !options.allowHttpError) {
      let bodyText: string | null = null;
      try {
        bodyText = await response.text();
      } catch (error) {
        if (timeout?.isTimedOut()) {
          throw new RequestFailure("timeout", url, `Request timed out after ${timeoutMs}ms`, { cause: error });
        }
      }
      throw new RequestFailure("http", url, `Request failed with status ${response.status}`, {
        status: response.status,
        bodyText,
      });
    }

    return { data: await readSuccessBody(response), response };
  } catch (error) {
    if (error instanceof RequestFailure) throw error;
    if (timeout?.isTimedOut()) {
      throw new RequestFailure("timeout", url, `Request timed out after ${timeoutMs}ms`, { cause: error });
    }
    if (signal?.aborted) {
      throw new RequestFailure("aborted", url, "Request was aborted", { cause: error });
    }
    throw new RequestFailure("network", url, "Network request failed", { cause: error });
  } finally {
    timeout?.dispose();
    parent.dispose();
  }
}

export async function requestResponse<T>(
  input: RequestInfo | URL,
  options: RequestLifecycleOptions,
  handleResponse: (response: Response) => Promise<T>,
): Promise<RequestResult<T>> {
  return executeRequest(input, options, handleResponse);
}

export async function requestJsonWithResponse<T>(
  input: RequestInfo | URL,
  options: RequestJsonOptions<T> = {},
): Promise<RequestResult<T>> {
  const url = inputLabel(input);
  const result = await executeRequest<unknown>(input, options, async (response) => {
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new RequestFailure("parse", url, "Response was not valid JSON", { bodyText: text, cause: error });
    }
  });

  if (!options.schema) return result as RequestResult<T>;
  const schema = await resolveSchemaLike(options.schema);
  if (!schema) return result as RequestResult<T>;
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) {
    throw new RequestFailure(
      "schema",
      url,
      `Response schema validation failed: ${formatSchemaLikeIssues(parsed.error.issues)}`,
    );
  }
  return { data: parsed.data, response: result.response };
}

export async function requestJson<T>(input: RequestInfo | URL, options: RequestJsonOptions<T> = {}): Promise<T> {
  return (await requestJsonWithResponse(input, options)).data;
}

export async function requestTextWithResponse(
  input: RequestInfo | URL,
  options: RequestLifecycleOptions = {},
): Promise<RequestResult<string>> {
  return executeRequest(input, options, (response) => response.text());
}

export async function requestBlob(input: RequestInfo | URL, options: RequestLifecycleOptions = {}): Promise<Blob> {
  return (await executeRequest(input, options, (response) => response.blob())).data;
}

export function isRequestCancellation(error: unknown): boolean {
  return error instanceof RequestFailure && (error.kind === "aborted" || error.kind === "superseded");
}

/** Serializes one UI action lane and rejects results from superseded requests. */
export class RequestSequence {
  private controller: AbortController | null = null;
  private version = 0;

  async run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.controller?.abort(new DOMException("Request superseded", "AbortError"));
    const controller = new AbortController();
    const version = ++this.version;
    this.controller = controller;

    try {
      const result = await operation(controller.signal);
      if (version !== this.version) {
        throw new RequestFailure("superseded", "request-sequence", "Request result was superseded");
      }
      return result;
    } finally {
      if (version === this.version) this.controller = null;
    }
  }

  cancel(): void {
    this.version += 1;
    this.controller?.abort(new DOMException("Request cancelled", "AbortError"));
    this.controller = null;
  }
}
