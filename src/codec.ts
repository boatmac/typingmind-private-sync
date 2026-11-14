type Node =
  | ["null"]
  | ["undefined"]
  | ["string", string]
  | ["boolean", boolean]
  | ["number", string]
  | ["bigint", string]
  | ["date", string]
  | ["blob", string, string]
  | ["file", string, string, string, number]
  | ["buffer", string]
  | ["view", string, string]
  | ["array", Node[]]
  | ["object", [string, Node][]]
  | ["map", [Node, Node][]]
  | ["set", Node[]];

export function base64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(text);
}

export function unbase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

async function encode(value: unknown, seen: Set<object>): Promise<Node> {
  if (value === null) return ["null"];
  if (value === undefined) return ["undefined"];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "number") {
    return ["number", Object.is(value, -0) ? "-0" : String(value)];
  }
  if (typeof value === "bigint") return ["bigint", String(value)];
  if (typeof value !== "object") throw new Error("Unsupported stored value type.");
  if (seen.has(value)) throw new Error("Cyclic app data is not supported; no sync performed.");
  seen.add(value);
  try {
    if (value instanceof Date) return ["date", value.toISOString()];
    if (typeof File !== "undefined" && value instanceof File) {
      return ["file", base64(new Uint8Array(await value.arrayBuffer())),
        value.type, value.name, value.lastModified];
    }
    if (value instanceof Blob) {
      return ["blob", base64(new Uint8Array(await value.arrayBuffer())), value.type];
    }
    if (value instanceof ArrayBuffer) return ["buffer", base64(new Uint8Array(value))];
    if (ArrayBuffer.isView(value)) {
      return ["view", value.constructor.name,
        base64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))];
    }
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length ||
          Array.from({ length: value.length }, (_, index) => index).some((index) => !Object.hasOwn(value, index))) {
        throw new Error("Sparse arrays or arrays with custom properties need a schema adapter.");
      }
      const entries: Node[] = [];
      for (const item of value) entries.push(await encode(item, seen));
      return ["array", entries];
    }
    if (value instanceof Map) {
      const entries: [Node, Node][] = [];
      for (const [key, item] of value) {
        entries.push([await encode(key, seen), await encode(item, seen)]);
      }
      return ["map", entries];
    }
    if (value instanceof Set) {
      const entries: Node[] = [];
      for (const item of value) entries.push(await encode(item, seen));
      return ["set", entries];
    }
    if (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) {
      throw new Error(`Unsupported stored object: ${value.constructor.name}`);
    }
    const entries: [string, Node][] = [];
    for (const key of Object.keys(value).sort()) {
      entries.push([key, await encode(Reflect.get(value, key), seen)]);
    }
    return ["object", entries];
  } finally {
    seen.delete(value);
  }
}

const views = {
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
  Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array,
};

function decode(node: Node): unknown {
  switch (node[0]) {
    case "null": return null;
    case "undefined": return undefined;
    case "string":
    case "boolean": return node[1];
    case "number": {
      const text = node[1];
      if (!/^(?:-0|NaN|Infinity|-Infinity|[-+\d.eE]+)$/.test(text)) {
        throw new Error("Invalid encoded number.");
      }
      return Number(text);
    }
    case "bigint": return BigInt(node[1]);
    case "date": return new Date(node[1]);
    case "buffer": return unbase64(node[1]).buffer;
    case "blob": return new Blob([unbase64(node[1])], { type: node[2] });
    case "file": return new File([unbase64(node[1])], node[3],
      { type: node[2], lastModified: node[4] });
    case "view": {
      const buffer = unbase64(node[2]).buffer;
      if (node[1] === "DataView") return new DataView(buffer);
      if (!Object.hasOwn(views, node[1])) throw new Error("Unknown binary view.");
      return new views[node[1] as keyof typeof views](buffer);
    }
    case "array": return node[1].map(decode);
    case "object": return Object.fromEntries(node[1].map(([key, item]) => [key, decode(item)]));
    case "map": return new Map(node[1].map(([key, item]) => [decode(key), decode(item)]));
    case "set": return new Set(node[1].map(decode));
    default: throw new Error("Unknown encoded value.");
  }
}

export async function pack(value: unknown): Promise<string> {
  return JSON.stringify(await encode(value, new Set()));
}

export async function unpack(text: string): Promise<unknown> {
  const value = decode(JSON.parse(text));
  if (await pack(value) !== text) throw new Error("Invalid or noncanonical stored value.");
  return value;
}

export async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
