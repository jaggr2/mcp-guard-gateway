import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Encrypts secrets at rest with AES-256-GCM under a master key derived from
 * `SECRET_MASTER_KEY`. Format: `v1:<iv(hex)>:<tag(hex)>:<ciphertext(hex)>`.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(masterKey: string) {
    this.key = createHash("sha256").update(masterKey).digest();
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
  }

  decrypt(payload: string): string {
    const [version, ivHex, tagHex, dataHex] = payload.split(":");
    if (version !== "v1") {
      throw new Error(`Unsupported secret format: ${version}`);
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(dataHex, "hex")),
      decipher.final(),
    ]);
    return plain.toString("utf8");
  }
}
