import type { Store } from "./db.ts";

const ITERATIONS = 210_000;
const b64 = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64");
const unb64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

export class Vault {
  private constructor(
    private readonly aesKey: CryptoKey,
    readonly sessionSecret: string,
  ) {}

  static async open(password: string, store: Store): Promise<Vault> {
    let salt = store.getValue<string>("vault_salt");
    if (!salt) {
      salt = b64(crypto.getRandomValues(new Uint8Array(16)));
      store.setValue("vault_salt", salt);
    }
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: unb64(salt), iterations: ITERATIONS },
      material,
      512,
    );
    const bytes = new Uint8Array(bits);
    const aesKey = await crypto.subtle.importKey("raw", bytes.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"]);
    return new Vault(aesKey, b64(bytes.slice(32)));
  }

  async encrypt(plain: string): Promise<{ iv: string; data: string }> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.aesKey, new TextEncoder().encode(plain));
    return { iv: b64(iv), data: b64(data) };
  }

  async decrypt(sealed: { iv: string; data: string }): Promise<string | null> {
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(sealed.iv) }, this.aesKey, unb64(sealed.data));
      return new TextDecoder().decode(plain);
    } catch {
      return null;
    }
  }
}
