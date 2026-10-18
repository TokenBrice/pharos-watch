// Preloaded before every resource/qualification child, including fixture setup.
// Exit rather than throw: production retry/fallback handlers must not swallow
// an unexpected network attempt and turn a memory measurement into a wait.
import net from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import dgram from "node:dgram";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";

function denyNetwork() {
  process.stderr.write("worker-memory-network-denied\n");
  process.exit(1);
}

globalThis.fetch = denyNetwork;
globalThis.WebSocket = denyNetwork;
const socketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // tsx uses local Unix-domain IPC; it is not an outbound network transport.
  // Node may pass its already-normalized argument array to Socket.connect.
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const path = typeof options === "string" ? options : options?.path;
  if (typeof path === "string" && path.startsWith("/")) {
    return Reflect.apply(socketConnect, this, args);
  }
  return denyNetwork();
};
http.request = denyNetwork;
http.get = denyNetwork;
https.request = denyNetwork;
https.get = denyNetwork;
tls.connect = denyNetwork;
dgram.createSocket = denyNetwork;
for (const api of [dns, dns.promises]) {
  for (const name of Object.keys(api)) {
    if (/^(?:lookup|resolve|reverse)/.test(name) || name === "Resolver") api[name] = denyNetwork;
  }
}
syncBuiltinESMExports();
