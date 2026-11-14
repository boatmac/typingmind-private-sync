import { AwsClient } from "aws4fetch";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { sha256 } from "./codec";
import type { ImmutableStore } from "./immutable-log";
import { StorageNetworkError, validateConfig, type Config, type Secrets } from "./provider";

const idPattern = /^[0-9a-f]{64}$/;
const parser = new XMLParser({
  ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, trimValues: false,
  isArray: (name) => name === "Contents",
});

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid S3 list XML structure.");
  return value as Record<string, unknown>;
}

export class ImmutableS3Store implements ImmutableStore {
  private aws: AwsClient;
  private base: string;
  private prefix: string;
  private bucket: string;

  constructor(config: Config, secrets: Secrets,
    private fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    namespace: "commits" | "backups" = "commits") {
    if (config.provider !== "s3") throw new Error("Immutable object listing requires the S3 provider.");
    this.base = validateConfig(config).href.replace(/\/+$/, "") + "/";
    this.bucket = config.bucket;
    this.prefix = config.prefix + "/" + namespace + "/";
    if (!secrets.accessKeyId || !secrets.secretAccessKey) throw new Error("S3 credentials are required.");
    this.aws = new AwsClient({
      accessKeyId: secrets.accessKeyId, secretAccessKey: secrets.secretAccessKey,
      sessionToken: secrets.sessionToken || undefined, service: "s3", region: config.region, retries: 0,
    });
  }

  private async request(url: URL, method: string, text?: string): Promise<Response> {
    const headers = new Headers();
    if (text !== undefined) headers.set("Content-Type", "application/json");
    const request = await this.aws.sign(url.href, {
      method, headers, body: text, credentials: "omit", cache: "no-store",
      redirect: "error", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(60_000),
      aws: { allHeaders: true },
    });
    try {
      return await this.fetcher(request);
    } catch (error) {
      throw new StorageNetworkError(url.href, error);
    }
  }

  private url(id: string): URL {
    if (!idPattern.test(id)) throw new Error("Invalid immutable object ID.");
    return new URL(this.base + [this.bucket, ...this.prefix.split("/"), id + ".json"]
      .filter(Boolean).map(encodeURIComponent).join("/"));
  }

  async list(): Promise<string[]> {
    const ids = new Set<string>();
    const tokens = new Set<string>();
    let token: string | undefined;
    for (let page = 0; page < 1000; page++) {
      const url = new URL(this.base + encodeURIComponent(this.bucket) + "/");
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", this.prefix);
      url.searchParams.set("max-keys", "1000");
      if (token !== undefined) url.searchParams.set("continuation-token", token);
      const response = await this.request(url, "GET");
      if (!response.ok) throw new Error(`S3 list failed (HTTP ${response.status}).`);
      const xml = await response.text();
      if (xml.length > 1_048_576 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) {
        throw new Error("Invalid or oversized S3 list XML.");
      }
      const parsed: unknown = parser.parse(xml);
      const result = object(object(parsed).ListBucketResult);
      if (result.Name !== this.bucket || result.Prefix !== this.prefix ||
          !["true", "false"].includes(String(result.IsTruncated))) {
        throw new Error("S3 list response does not match the requested scope.");
      }
      const entries = result.Contents ?? [];
      if (!Array.isArray(entries)) throw new Error("Invalid S3 list entries.");
      for (const entry of entries) {
        const key = object(entry).Key;
        if (typeof key !== "string" || !key.startsWith(this.prefix)) throw new Error("S3 returned an out-of-scope key.");
        const suffix = key.slice(this.prefix.length);
        if (!/^[0-9a-f]{64}\.json$/.test(suffix)) throw new Error("Unexpected object in immutable commit prefix.");
        const id = suffix.slice(0, -5);
        if (ids.has(id)) throw new Error("S3 pagination repeated an object.");
        ids.add(id);
        if (ids.size > 1000) throw new Error("Prototype history limit exceeded; no history was discarded.");
      }
      if (result.IsTruncated === "false") return [...ids].sort();
      const next = result.NextContinuationToken;
      if (typeof next !== "string" || !next || next.length > 4096 || tokens.has(next)) {
        throw new Error("S3 pagination is missing a token or cannot progress.");
      }
      tokens.add(next);
      token = next;
    }
    throw new Error("S3 pagination limit exceeded; incomplete listing rejected.");
  }

  async get(id: string): Promise<string | null> {
    const response = await this.request(this.url(id), "GET");
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`S3 commit GET failed (HTTP ${response.status}).`);
    return response.text();
  }

  async put(id: string, text: string): Promise<void> {
    if (await sha256(text) !== id) throw new Error("Immutable upload content does not match its object ID.");
    const response = await this.request(this.url(id), "PUT", text);
    if (!response.ok) throw new Error(`S3 commit PUT failed (HTTP ${response.status}); retain ciphertext for retry.`);
  }
}
