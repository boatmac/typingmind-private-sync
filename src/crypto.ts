import { base64, unbase64 } from "./codec";

const iterations = 600_000;
const context = new TextEncoder().encode("typingmind-private-sync/v1");

export class Vault {
  private keys = new Map<string, CryptoKey>();

  constructor(private password: string) {
    if (password.length < 12) throw new Error("Use an encryption passphrase of at least 12 characters.");
  }

  private async derive(salt: string): Promise<CryptoKey> {
    const cached = this.keys.get(salt);
    if (cached) return cached;
    const material = await crypto.subtle.importKey("raw",
      new TextEncoder().encode(this.password), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: unbase64(salt), iterations, hash: "SHA-256" },
      material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    if (this.keys.size >= 8) this.keys.clear();
    this.keys.set(salt, key);
    return key;
  }

  private salt = base64(crypto.getRandomValues(new Uint8Array(16)));

  async seal(value: unknown): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: context },
      await this.derive(this.salt), new TextEncoder().encode(JSON.stringify(value)));
    return JSON.stringify({
      format: "tmps-v1", iterations, salt: this.salt, iv: base64(iv),
      data: base64(new Uint8Array(encrypted)),
    });
  }

  async open(text: string): Promise<unknown> {
    const envelope: unknown = JSON.parse(text);
    if (!envelope || typeof envelope !== "object" ||
        !("format" in envelope) || envelope.format !== "tmps-v1" ||
        !("iterations" in envelope) || envelope.iterations !== iterations ||
        !("salt" in envelope) || typeof envelope.salt !== "string" ||
        !("iv" in envelope) || typeof envelope.iv !== "string" ||
        !("data" in envelope) || typeof envelope.data !== "string" ||
        unbase64(envelope.salt).length !== 16 || unbase64(envelope.iv).length !== 12) {
      throw new Error("Unsupported encrypted snapshot format.");
    }
    let decrypted: ArrayBuffer;
    try {
      decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: unbase64(envelope.iv), additionalData: context },
        await this.derive(envelope.salt), unbase64(envelope.data));
    } catch (error) {
      throw new Error("Decryption failed: wrong passphrase or damaged data.", { cause: error });
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decrypted));
  }
}
