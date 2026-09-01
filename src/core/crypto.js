import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function getEncryptionKey() {
  const secret = process.env.OAUTH_TOKEN_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error("Missing OAUTH_TOKEN_ENCRYPTION_KEY");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptText(plainText) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptText(payload) {
  const key = getEncryptionKey();
  const [ivB64, authTagB64, dataB64] = String(payload).split(":");
  if (!ivB64 || !authTagB64 || !dataB64) {
    throw new Error("Invalid encrypted payload format");
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
