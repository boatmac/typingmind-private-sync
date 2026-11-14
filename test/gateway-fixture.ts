import { once } from "node:events";
import { createGatewayServer, type GatewayConfig } from "../src/gateway";
import { storageServer } from "./http-server";

export const gatewayDefaults: GatewayConfig = {
  upstream: "https://app.koofr.net/dav/Koofr/AppData/Test/",
  upstreamUsername: "upstream-test-user",
  upstreamPassword: "upstream-test-app-password",
  username: "gateway-test-user",
  password: "gateway-test-password-not-a-secret-12345",
  prefix: "gateway-test",
  origins: ["https://www.typingmind.com"],
  maxBodyBytes: 1024 * 1024,
  maxConcurrent: 4,
  timeoutMs: 5000,
};

export async function gatewayFixture(overrides: Partial<GatewayConfig> = {}, customFetch?: typeof fetch) {
  const backend = await storageServer();
  const calls: Request[] = [];
  const logs: string[] = [];
  const config = { ...gatewayDefaults, ...overrides };
  const fetcher: typeof fetch = customFetch ?? (async (input, init) => {
    const request = new Request(input, init);
    calls.push(request.clone());
    return fetch(backend.url + new URL(request.url).pathname, {
      method: request.method, headers: request.headers, signal: request.signal,
      body: request.method === "PUT" ? await request.arrayBuffer() : undefined,
      redirect: request.redirect,
    });
  });
  const server = createGatewayServer(config, fetcher, (message) => logs.push(message));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing gateway address.");
  return {
    config, backend, server, calls, logs,
    url: `http://127.0.0.1:${address.port}`,
    auth: "Basic " + Buffer.from(`${config.username}:${config.password}`).toString("base64"),
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      await backend.close();
    },
  };
}
