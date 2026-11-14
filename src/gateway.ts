import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type GatewayConfig = {
  upstream: string;
  upstreamUsername: string;
  upstreamPassword: string;
  username: string;
  password: string;
  prefix: string;
  origins: string[];
  maxBodyBytes: number;
  maxConcurrent: number;
  timeoutMs: number;
};

class HttpFailure extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

const methods = new Set(["GET", "HEAD", "PUT", "DELETE", "MKCOL"]);
const headers = new Set(["authorization", "content-type", "if-match", "if-none-match"]);
const objectName = /^(?:head|probe-[0-9a-f-]+|backup-[0-9a-f-]+)\.json$/;

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return Number(value);
}

export function gatewayConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const config: GatewayConfig = {
    upstream: env.KOOFR_WEBDAV_URL ?? "",
    upstreamUsername: env.KOOFR_USERNAME ?? "",
    upstreamPassword: env.KOOFR_APP_PASSWORD ?? "",
    username: env.GATEWAY_USERNAME ?? "",
    password: env.GATEWAY_PASSWORD ?? "",
    prefix: env.GATEWAY_PREFIX ?? "typingmind-private",
    origins: (env.GATEWAY_ALLOWED_ORIGINS ?? "https://www.typingmind.com")
      .split(",").map((value) => value.trim()),
    maxBodyBytes: positiveInteger(env.GATEWAY_MAX_BODY_BYTES, 256 * 1024 * 1024, "GATEWAY_MAX_BODY_BYTES"),
    maxConcurrent: positiveInteger(env.GATEWAY_MAX_CONCURRENT, 4, "GATEWAY_MAX_CONCURRENT"),
    timeoutMs: positiveInteger(env.GATEWAY_TIMEOUT_MS, 55_000, "GATEWAY_TIMEOUT_MS"),
  };
  validateGatewayConfig(config);
  return config;
}

function validateGatewayConfig(config: GatewayConfig): void {
  if (/%2f|%5c|%2e|(?:^|\/)\.{1,2}(?:\/|$)|\\/i.test(config.upstream)) {
    throw new Error("KOOFR_WEBDAV_URL must not contain traversal or encoded path separators.");
  }
  let url: URL;
  try {
    url = new URL(config.upstream);
  } catch (error) {
    throw new Error("KOOFR_WEBDAV_URL must be a Koofr HTTPS WebDAV URL without credentials.", { cause: error });
  }
  if (url.protocol !== "https:" || url.hostname !== "app.koofr.net" || url.port ||
      url.username || url.password || url.search || url.hash ||
      !/^\/dav\/Koofr(?:\/|$)/.test(url.pathname) ||
      /%2f|%5c|%2e|\\|\/\//i.test(url.pathname)) {
    throw new Error("KOOFR_WEBDAV_URL must target app.koofr.net/dav/Koofr, without credentials or ambiguous paths.");
  }
  if (!config.upstreamUsername || config.upstreamUsername.includes(":") || !config.upstreamPassword) {
    throw new Error("Set KOOFR_USERNAME and KOOFR_APP_PASSWORD (not the account's main password).");
  }
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(config.username) ||
      !/^[\x21-\x7e]{32,256}$/.test(config.password)) {
    throw new Error("Set GATEWAY_USERNAME and a separate random GATEWAY_PASSWORD of 32-256 characters.");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(config.prefix)) {
    throw new Error("GATEWAY_PREFIX must be one dedicated folder name, without slashes.");
  }
  if (!config.origins.length) throw new Error("At least one exact gateway origin is required.");
  for (const origin of config.origins) {
    const value = new URL(origin);
    if (value.origin !== origin || (value.protocol !== "https:" &&
        !(value.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(value.hostname)))) {
      throw new Error("Allowed origins must be exact HTTPS origins; loopback HTTP is allowed for tests.");
    }
  }
  for (const value of [config.maxBodyBytes, config.maxConcurrent, config.timeoutMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Gateway limits must be positive integers.");
  }
}

function authentication(username: string, password: string): string {
  return "Basic " + Buffer.from(`${username}:${password}`, "utf8").toString("base64");
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function pathFor(request: IncomingMessage, prefix: string): { suffix: string; directory: boolean } {
  const path = request.url ?? "";
  if (/[?%#\\]/.test(path)) throw new HttpFailure(400, "invalid_path");
  const base = `/dav/${prefix}/`;
  if (!path.startsWith(base)) throw new HttpFailure(404, "outside_gateway_scope");
  const suffix = path.slice(base.length);
  if (suffix !== "" && !objectName.test(suffix)) throw new HttpFailure(404, "outside_gateway_scope");
  return { suffix: prefix + "/" + suffix, directory: suffix === "" };
}

async function readBody(request: IncomingMessage, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers["content-length"];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw new HttpFailure(413, "body_too_large");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    if (!Buffer.isBuffer(chunk)) throw new HttpFailure(400, "invalid_body");
    length += chunk.length;
    if (length > limit) throw new HttpFailure(413, "body_too_large");
    chunks.push(chunk);
  }
  return Uint8Array.from(Buffer.concat(chunks));
}

function sendError(request: IncomingMessage, response: ServerResponse, status: number, code: string): void {
  if (response.destroyed) return;
  if (response.headersSent) { response.destroy(); return; }
  request.resume();
  response.setHeader("Content-Type", "application/json");
  response.writeHead(status).end(JSON.stringify({ error: code }));
}

export function createGatewayServer(
  config: GatewayConfig,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  log: (message: string) => void = (message) => console.error(`[Private Sync Gateway] ${message}`),
) {
  validateGatewayConfig(config);
  const upstreamBase = new URL(config.upstream).href.replace(/\/+$/, "") + "/";
  const upstreamAuth = authentication(config.upstreamUsername, config.upstreamPassword);
  const expectedAuth = digest(authentication(config.username, config.password));
  const allowedOrigins = new Set(config.origins);
  let active = 0;
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      response.setHeader("Vary", "Origin");
      const origin = request.headers.origin;
      if (origin !== undefined && (typeof origin !== "string" || !allowedOrigins.has(origin))) {
        throw new HttpFailure(403, "origin_not_allowed");
      }
      if (origin) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Access-Control-Expose-Headers", "ETag");
      }
      const method = request.method ?? "";
      if (request.url === "/healthz" && (method === "GET" || method === "HEAD")) {
        response.setHeader("Content-Type", "application/json");
        response.writeHead(200).end(JSON.stringify({ status: "ready", upstreamTested: false }));
        return;
      }
      const target = pathFor(request, config.prefix);
      if (method === "OPTIONS") {
        const wanted = request.headers["access-control-request-method"];
        const wantedHeaders = String(request.headers["access-control-request-headers"] ?? "")
          .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
        if (!origin || typeof wanted !== "string" || !methods.has(wanted) ||
            wantedHeaders.some((header) => !headers.has(header))) {
          throw new HttpFailure(403, "preflight_not_allowed");
        }
        response.setHeader("Access-Control-Allow-Methods", [...methods].join(", "));
        response.setHeader("Access-Control-Allow-Headers", [...headers].join(", "));
        response.setHeader("Access-Control-Max-Age", "600");
        response.writeHead(204).end();
        return;
      }
      if (!methods.has(method)) throw new HttpFailure(405, "method_not_allowed");
      const auth = request.headers.authorization;
      if (!auth || auth.length > 512 || !timingSafeEqual(digest(auth), expectedAuth)) {
        response.setHeader("WWW-Authenticate", 'Basic realm="Private Sync Gateway"');
        throw new HttpFailure(401, "gateway_auth_required");
      }
      if ((method === "MKCOL") !== target.directory) {
        throw new HttpFailure(405, "method_not_allowed_for_path");
      }
      if (method === "DELETE" && !target.suffix.split("/").at(-1)?.startsWith("probe-")) {
        throw new HttpFailure(403, "only_probe_deletion_allowed");
      }
      const forwarded = new Headers({ Authorization: upstreamAuth });
      if (method === "PUT") {
        const match = request.headers["if-match"];
        const none = request.headers["if-none-match"];
        if ((match === undefined) === (none === undefined)) {
          throw new HttpFailure(428, "exactly_one_write_precondition_required");
        }
        if ((match !== undefined && (typeof match !== "string" || !/^"[^"]+"$/.test(match))) ||
            (none !== undefined && none !== "*")) {
          throw new HttpFailure(400, "invalid_write_precondition");
        }
        if (match) forwarded.set("If-Match", match);
        if (none) forwarded.set("If-None-Match", none);
        if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
          throw new HttpFailure(415, "json_content_type_required");
        }
        forwarded.set("Content-Type", "application/json");
      }
      if (active >= config.maxConcurrent) {
        response.setHeader("Retry-After", "1");
        throw new HttpFailure(503, "gateway_busy");
      }
      active++;
      try {
        const body = method === "PUT" ? await readBody(request, config.maxBodyBytes) : undefined;
        const controller = new AbortController();
        const disconnected = () => {
          if (!response.writableFinished) controller.abort();
        };
        response.once("close", disconnected);
        const timer = setTimeout(() => controller.abort(new Error("upstream_timeout")), config.timeoutMs);
        try {
          let upstream: Response;
          try {
            upstream = await fetcher(upstreamBase + target.suffix, {
              method, headers: forwarded, body, signal: controller.signal,
              redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
            });
          } catch {
            if (response.destroyed) return;
            throw new HttpFailure(controller.signal.aborted ? 504 : 502, "upstream_request_failed");
          }
          if (upstream.status >= 300 && upstream.status < 400) {
            throw new HttpFailure(502, "upstream_redirect_blocked");
          }
          if (upstream.status >= 500 || upstream.status === 401 || upstream.status === 403) {
            log(`upstream_http_${upstream.status}`);
          }
          const etag = upstream.headers.get("ETag");
          if (etag) response.setHeader("ETag", etag);
          response.setHeader("Content-Type", "application/json");
          response.writeHead(upstream.status);
          if (method === "HEAD" || !upstream.body) { response.end(); return; }
          const reader = upstream.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (response.destroyed) { await reader.cancel(); return; }
              if (!response.write(value)) {
                await once(response, "drain", { signal: controller.signal });
              }
            }
            response.end();
          } finally {
            reader.releaseLock();
          }
        } finally {
          clearTimeout(timer);
          response.removeListener("close", disconnected);
        }
      } finally {
        active--;
      }
    })().catch((error: unknown) => {
      if (error instanceof HttpFailure) {
        if (error.status >= 500) log(error.code);
        sendError(request, response, error.status, error.code);
      } else {
        log("gateway_request_failed");
        sendError(request, response, 500, "gateway_request_failed");
      }
    });
  });
  server.requestTimeout = Math.max(1000, config.timeoutMs);
  server.headersTimeout = server.requestTimeout;
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const config = gatewayConfig(process.env);
    const port = positiveInteger(process.env.GATEWAY_PORT, 8787, "GATEWAY_PORT");
    if (port > 65535) throw new Error("GATEWAY_PORT must be at most 65535.");
    const server = createGatewayServer(config);
    server.on("error", () => {
      console.error("[Private Sync Gateway] Server startup failed.");
      process.exitCode = 1;
    });
    server.listen(port, process.env.GATEWAY_HOST ?? "127.0.0.1", () => {
      console.log("[Private Sync Gateway] Listening. Health status does not verify Koofr compatibility.");
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        server.close();
        setTimeout(() => server.closeAllConnections(), 10_000).unref();
      });
    }
  } catch (error) {
    console.error("[Private Sync Gateway]", error instanceof Error ? error.message : "Invalid configuration.");
    process.exitCode = 1;
  }
}
