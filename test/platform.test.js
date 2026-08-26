import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeForLog } from "../src/platform/logging/context.js";
import { validateEnvironment } from "../src/platform/config/env.js";

describe("platform logging", () => {
  it("redacts sensitive fields", () => {
    const sanitized = sanitizeForLog({
      email: "user@example.com",
      password: "secret123",
      token: "abc",
      nested: { apiKey: "key" },
    });
    assert.equal(sanitized.password, "[redacted]");
    assert.equal(sanitized.token, "[redacted]");
    assert.equal(sanitized.nested.apiKey, "[redacted]");
    assert.equal(sanitized.email, "user@example.com");
  });
});

describe("platform env validation", () => {
  it("reports missing required variables", () => {
    const original = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    const result = validateEnvironment();
    assert.equal(result.ok, false);
    assert.ok(result.missing.includes("JWT_SECRET"));
    process.env.JWT_SECRET = original;
  });
});
