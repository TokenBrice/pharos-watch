import type { LiveReserveInput, LiveReservesConfig } from "@shared/types/live-reserves";

type JsonInput = Extract<LiveReserveInput, { kind: "http-json" }>;
type HtmlInput = Extract<LiveReserveInput, { kind: "http-html" }>;
type EvmInput = Extract<LiveReserveInput, { kind: "onchain-evm" }>;

export function isHttpJsonInput(input: LiveReserveInput): input is JsonInput {
  return input.kind === "http-json";
}

function isOnchainEvmInput(input: LiveReserveInput): input is EvmInput {
  return input.kind === "onchain-evm";
}

export function isHttpHtmlInput(input: LiveReserveInput): input is HtmlInput {
  return input.kind === "http-html";
}

export function requireJsonInput(input: LiveReserveInput, adapterName: string): JsonInput {
  if (!isHttpJsonInput(input)) {
    throw new Error(`${adapterName} adapter requires an http-json primary input`);
  }
  return input;
}

export function requireHtmlInput(input: LiveReserveInput, adapterName: string): HtmlInput {
  if (!isHttpHtmlInput(input)) {
    throw new Error(`${adapterName} adapter requires an http-html primary input`);
  }
  return input;
}

export function requireOnchainInput(input: LiveReserveInput, adapterName: string): EvmInput {
  if (!isOnchainEvmInput(input)) {
    throw new Error(`${adapterName} adapter requires an onchain-evm primary input`);
  }
  return input;
}

export function requireJsonInputFromConfig(
  config: LiveReservesConfig,
  adapterName: string,
): JsonInput {
  return requireJsonInput(config.inputs.primary, adapterName);
}
