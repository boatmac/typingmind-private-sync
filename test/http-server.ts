import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";

export async function storageServer() {
  const objects = new Map<string, { text: string; etag: string }>();
  const requests: { method: string; path: string; headers: IncomingHttpHeaders }[] = [];
  let version = 0;
  const options = { unsafe: false, noEtag: false, status: 0, listPageSize: 1000 };
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET,PUT,DELETE,MKCOL,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "*");
    response.setHeader("Access-Control-Expose-Headers", "ETag");
    if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
    const path = request.url!;
    const method = request.method!;
    requests.push({ method, path, headers: request.headers });
    if (options.status) { response.writeHead(options.status).end(); return; }
    if (method === "MKCOL") { response.writeHead(201).end(); return; }
    if (method === "DELETE") { objects.delete(path); response.writeHead(204).end(); return; }
    const url = new URL(path, "http://127.0.0.1");
    if (method === "GET" && url.searchParams.get("list-type") === "2") {
      const bucket = url.pathname.split("/")[1]!;
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [...objects.keys()].filter((key) => key.startsWith(`/${bucket}/${prefix}`))
        .map((key) => key.slice(bucket.length + 2)).sort();
      const start = Number(url.searchParams.get("continuation-token") ?? "0");
      const page = keys.slice(start, start + options.listPageSize);
      const next = start + page.length;
      const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      response.setHeader("Content-Type", "application/xml");
      response.end(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
        `<Name>${escape(bucket)}</Name><Prefix>${escape(prefix)}</Prefix>` +
        `<IsTruncated>${next < keys.length}</IsTruncated>` +
        (next < keys.length ? `<NextContinuationToken>${next}</NextContinuationToken>` : "") +
        page.map((key) => `<Contents><Key>${escape(key)}</Key></Contents>`).join("") +
        "</ListBucketResult>");
      return;
    }
    const existing = objects.get(path);
    if (method === "GET") {
      if (!existing) { response.writeHead(404).end(); return; }
      if (!options.noEtag) response.setHeader("ETag", existing.etag);
      response.writeHead(200).end(existing.text);
      return;
    }
    if (method === "PUT") {
      if (!options.unsafe &&
          ((request.headers["if-none-match"] === "*" && existing) ||
          (request.headers["if-match"] && request.headers["if-match"] !== existing?.etag))) {
        response.writeHead(412).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      objects.set(path, { text, etag: `"${++version}"` });
      response.writeHead(201).end();
      return;
    }
    response.writeHead(405).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    objects, requests, options,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
