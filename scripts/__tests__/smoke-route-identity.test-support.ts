import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export async function withRedirectFixture(
  requestedPath: string,
  destination: string,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    if (request.url === requestedPath) {
      response.writeHead(302, { Location: destination });
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end('<html><body>A healthy page with enough content.</body><script src="/healthy.js"></script></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
