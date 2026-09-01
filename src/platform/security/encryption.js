import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

function deriveKey(secret) {
  return createHash("sha256").update(secret).digest();
}

export function encryptSecret(plaintext, secret = process.env.OAUTH_TOKEN_ENCRYPTION_KEY) {
  if (!secret) throw new Error("Encryption secret is not configured.");
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, deriveKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptSecret(ciphertext, secret = process.env.OAUTH_TOKEN_ENCRYPTION_KEY) {
  if (!secret) throw new Error("Encryption secret is not configured.");
  const raw = Buffer.from(ciphertext, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = createDecipheriv(ALGORITHM, deriveKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export const SENSITIVE_CLASSIFICATIONS = {
  PII: ["email", "ip", "userAgent", "phone"],
  CREDENTIAL: ["password", "token", "apiKey", "secret"],
  FINANCIAL: ["commission", "payment", "invoice"],
};
