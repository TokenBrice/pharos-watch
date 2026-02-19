/**
 * Wraps an API handler with standardized error handling.
 * Catches unhandled exceptions, logs them with the endpoint name, and returns a 500 JSON response.
 *
 * CORS headers are applied in index.ts after the handler returns,
 * so error responses from this wrapper get CORS automatically.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiHandler<T extends any[] = any[]> = (...args: T) => Promise<Response>;

export function withErrorHandler<T extends unknown[]>(
  endpoint: string,
  handler: ApiHandler<T>,
): ApiHandler<T> {
  return async (...args: T): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      console.error(`[api] Error in ${endpoint}:`, err);
      return new Response(
        JSON.stringify({ error: "Internal Server Error" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  };
}
