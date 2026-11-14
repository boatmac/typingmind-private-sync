import { AwsClient } from "aws4fetch";
import { base64 } from "./codec";

export type Config = {
  provider: "webdav" | "s3";
  endpoint: string;
  prefix: string;
  bucket: string;
  region: string;
  username: string;
  exclusions: string[];
};
export type Secrets = {
  password: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
};
export type RemoteObject = { text: string; etag: string };
export interface ObjectStore {
  get(key: string): Promise<RemoteObject | null>;
  put(key: string, text: string, expected: string | null): Promise<void>;
  probe(): Promise<void>;
}

export class PreconditionError extends Error {
  constructor() {
    super("Remote data changed, or conditional writes were rejected. Retry sync; nothing was force-overwritten.");
  }
}

export class StorageNetworkError extends Error {
  constructor(url: string, cause: unknown) {
    super(`Storage network request failed (${new URL(url).hostname}). No HTTP response was available to the extension. ` +
      "Check CORS/preflight, TLS certificates and connectivity. " +
      "This does not establish that the password or encryption passphrase is wrong.", { cause });
    this.name = "StorageNetworkError";
  }
}

export function validateConfig(config: Config): URL {
  const url = new URL(config.endpoint);
  if (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Storage must use HTTPS (HTTP is allowed only on loopback for testing).");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Endpoint must not contain credentials, query parameters, or a fragment.");
  }
  if (/%2f|%5c|%2e/i.test(url.pathname)) throw new Error("Ambiguous endpoint path.");
  if (config.provider !== "webdav" && config.provider !== "s3") throw new Error("Unknown provider.");
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(config.prefix)) {
    throw new Error("Use a nonempty dedicated prefix of letters, digits, underscores, hyphens, and slashes.");
  }
  if (config.provider === "s3" && (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) ||
      !config.region.trim())) throw new Error("Set a valid S3 bucket and region.");
  if (config.username.includes(":")) throw new Error("WebDAV username cannot contain a colon.");
  if (!Array.isArray(config.exclusions) || config.exclusions.some((key) => typeof key !== "string")) {
    throw new Error("Invalid exclusions.");
  }
  return url;
}

export function binding(config: Config): string {
  const url = validateConfig(config);
  return JSON.stringify([
    config.provider, url.href.replace(/\/+$/, ""),
    config.provider === "s3" ? config.bucket : "", config.prefix,
    [...config.exclusions].sort(),
  ]);
}

export class HttpStore implements ObjectStore {
  private base: string;
  private aws?: AwsClient;
  private auth?: string;
  private initialized = false;

  constructor(private config: Config, secrets: Secrets,
    private fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.base = validateConfig(config).href.replace(/\/+$/, "") + "/";
    if (config.provider === "s3") {
      if (!secrets.accessKeyId || !secrets.secretAccessKey) throw new Error("S3 credentials are required.");
      this.aws = new AwsClient({
        accessKeyId: secrets.accessKeyId, secretAccessKey: secrets.secretAccessKey,
        sessionToken: secrets.sessionToken || undefined, region: config.region,
        service: "s3", retries: 0,
      });
    } else {
      if (!config.username || !secrets.password) throw new Error("WebDAV username and password are required.");
      this.auth = "Basic " + base64(new TextEncoder().encode(`${config.username}:${secrets.password}`));
    }
  }

  private async request(path: string, method: string, text?: string,
    conditions: Record<string, string> = {}): Promise<Response> {
    const url = this.base + path.split("/").map(encodeURIComponent).join("/");
    const headers = new Headers(conditions);
    if (text !== undefined) headers.set("Content-Type", "application/json");
    if (this.auth) headers.set("Authorization", this.auth);
    const init: RequestInit = {
      method, headers, body: text, cache: "no-store", credentials: "omit",
      redirect: "error", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(60_000),
    };
    const request = this.aws ? await this.aws.sign(url, { ...init, aws: { allHeaders: true } }) :
      new Request(url, init);
    try {
      return await this.fetcher(request);
    } catch (error) {
      throw new StorageNetworkError(url, error);
    }
  }

  private path(key: string): string {
    if (!/^(?:head|probe-[0-9a-f-]+|backup-[0-9a-f-]+)\.json$/.test(key)) {
      throw new Error("Invalid storage object name.");
    }
    return [this.config.provider === "s3" ? this.config.bucket : "",
      this.config.prefix, key].filter(Boolean).join("/");
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.config.provider === "webdav") {
      const segments = this.config.prefix.split("/");
      for (let i = 1; i <= segments.length; i++) {
        const response = await this.request(segments.slice(0, i).join("/") + "/", "MKCOL");
        if (response.status !== 201 && response.status !== 405) {
          throw new Error(`WebDAV MKCOL failed (HTTP ${response.status}). Pre-create the dedicated prefix if MKCOL is disabled.`);
        }
      }
    }
    this.initialized = true;
  }

  async get(key: string): Promise<RemoteObject | null> {
    await this.init();
    const response = await this.request(this.path(key), "GET");
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Storage GET failed (HTTP ${response.status}).`);
    const etag = response.headers.get("ETag");
    if (!etag || !/^"[^"]+"$/.test(etag)) {
      throw new Error("Storage must expose a strong ETag header through CORS.");
    }
    return { text: await response.text(), etag };
  }

  async put(key: string, text: string, expected: string | null): Promise<void> {
    await this.init();
    const response = await this.request(this.path(key), "PUT", text,
      expected === null ? { "If-None-Match": "*" } : { "If-Match": expected });
    if (response.status === 409 || response.status === 412) throw new PreconditionError();
    if (!response.ok) throw new Error(`Storage PUT failed (HTTP ${response.status}); inspect storage before retrying.`);
  }

  async probe(): Promise<void> {
    const key = `probe-${crypto.randomUUID()}.json`;
    const original = JSON.stringify({ probe: crypto.randomUUID() });
    await this.put(key, original, null);
    let primary: unknown;
    try {
      const first = await this.get(key);
      if (!first || first.text !== original) throw new Error("Storage read-after-write verification failed.");
      for (const condition of [null, '"tmps-deliberately-wrong-etag"']) {
        let rejected = false;
        try {
          await this.put(key, "{}", condition);
        } catch (error) {
          if (!(error instanceof PreconditionError)) throw error;
          rejected = true;
        }
        if (!rejected) throw new Error("Unsafe server: conditional writes are ignored. Sync is blocked.");
      }
      await this.put(key, original, first.etag);
      const verified = await this.get(key);
      if (!verified || verified.text !== original) throw new Error("Conditional write verification failed.");
    } catch (error) {
      primary = error;
    }
    try {
      const response = await this.request(this.path(key), "DELETE");
      if (!response.ok && response.status !== 404) {
        throw new Error(`Probe cleanup failed (HTTP ${response.status}).`);
      }
    } catch (error) {
      if (primary) console.error("[Private Sync] Probe cleanup also failed.", error);
      else throw error;
    }
    if (primary) throw primary;
  }
}
