export function redactRpcUrlForEvidence(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).origin;
  } catch {
    return "[invalid-rpc-url]";
  }
}
