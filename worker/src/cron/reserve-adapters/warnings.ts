import type { LiveReserveWarning } from "@shared/types/live-reserves";
import { toErrorMessage } from "@shared/lib/error-utils";

export function reserveInfoWarning(code: string, message: string): LiveReserveWarning {
  return { code, message, severity: "info", effect: "info" };
}

export function reserveDegradedWarning(code: string, message: string): LiveReserveWarning {
  return { code, message, severity: "warning", effect: "degraded" };
}

export function reserveFatalWarning(code: string, message: string): LiveReserveWarning {
  return { code, message, severity: "warning", effect: "fatal" };
}

const SECRET_QUERY_PARAMS = [
  "apikey",
  "api_key",
  "key",
  "token",
  "auth",
  "authorization",
  "access_token",
  "secret",
];

// eslint-disable-next-line security/detect-non-literal-regexp -- composed from the SECRET_QUERY_PARAMS module constant; no user input.
const SECRET_PARAM_PATTERN = new RegExp(
  `([?&])(${SECRET_QUERY_PARAMS.join("|")})=([^&#\\s]*)`,
  "gi",
);

const URL_PATTERN = /https?:\/\/\S+/gi;

/** Redact common secret query params (apikey, token, etc.) inside any URL-shaped
 *  substring. Non-URL substrings pass through unchanged. */
export function redactUrlSecrets(value: string): string {
  return value.replace(URL_PATTERN, (url) =>
    url.replace(SECRET_PARAM_PATTERN, (_match, sep: string, name: string) => `${sep}${name}=REDACTED`),
  );
}

/** Await a fetch/parse promise; on rejection, push an info warning that includes
 *  the underlying error message and return `null`. Use this instead of silent
 *  `.catch(() => null)` so operators see what actually failed. */
export async function catchAndWarn<T>(
  promise: Promise<T>,
  code: string,
  label: string,
  warnings: LiveReserveWarning[],
): Promise<T | null> {
  try {
    return await promise;
  } catch (error) {
    const detail = toErrorMessage(error);
    warnings.push(reserveInfoWarning(code, redactUrlSecrets(`${label}: ${detail}`)));
    return null;
  }
}
