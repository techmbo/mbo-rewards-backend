import { createHash } from "node:crypto";

export function hashPii(value) {
  if (value == null || value === "") return null;
  return createHash("sha256").update(String(value)).digest("hex");
}
