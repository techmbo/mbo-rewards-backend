import "dotenv/config";
import http from "node:http";
import { createApp } from "../../src/app.js";

export function startTestServer() {
  const app = createApp();
  const server = http.createServer(app);

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}/api`,
        async close() {
          await new Promise((res, rej) => server.close((err) => (err ? rej(err) : res())));
        },
      });
    });
    server.on("error", reject);
  });
}

export async function apiRequest(baseUrl, { method = "GET", path, token, body } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  return { status: response.status, json };
}
