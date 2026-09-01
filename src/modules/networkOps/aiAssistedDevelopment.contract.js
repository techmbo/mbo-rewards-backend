/**
 * Pointer 24 — AI-assisted development rules.
 * AI is an implementation assistant only; MBO architecture and canonical naming are fixed.
 *
 * Every network integration task must ship one network + one source object with:
 *   target contract, source fixture, mapping rows, expected canonical output, test cases.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NETWORK_PLUG_IN_LAYERS } from "../client/clientBoundary.contract.js";
import {
  NETWORK_INTEGRATION_OBJECT_SEQUENCE,
  resolveSequenceRank,
  resolveSequenceStage,
} from "./networkIntegrationSequence.js";

export {
  NETWORK_INTEGRATION_OBJECT_SEQUENCE,
  resolveSequenceRank,
  resolveSequenceStage,
};

export const CONTRACT_POINTER = 24;

/** Required artifacts for every AI network-integration coding task. */
export const AI_TASK_REQUIRED_INPUTS = Object.freeze([
  "targetContract",
  "sourceFixture",
  "mappingRows",
  "expectedCanonical",
  "testCases",
]);

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const AI_INTEGRATION_FIXTURES_ROOT = join(MODULE_DIR, "../../../test/fixtures/networks");

export class AiIntegrationTaskError extends Error {
  constructor(message, { code = "AI_INTEGRATION_TASK_INVALID", details = null } = {}) {
    super(message);
    this.name = "AiIntegrationTaskError";
    this.code = code;
    this.details = details;
    this.contractPointer = CONTRACT_POINTER;
  }
}

export function fixtureBundleDir(network, sourceObject) {
  return join(
    AI_INTEGRATION_FIXTURES_ROOT,
    String(network || "").toLowerCase(),
    String(sourceObject || "").toLowerCase(),
  );
}

function readJsonFile(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Load a Pointer 24 fixture bundle from test/fixtures/networks/{network}/{sourceObject}/.
 */
export function loadAiIntegrationFixtureBundle(network, sourceObject) {
  const dir = fixtureBundleDir(network, sourceObject);
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new AiIntegrationTaskError(`Fixture manifest missing: ${manifestPath}`, {
      code: "AI_FIXTURE_MANIFEST_MISSING",
    });
  }

  const manifest = readJsonFile(manifestPath);
  const net = String(network || "").toLowerCase();
  const obj = String(sourceObject || "").toLowerCase();

  if (String(manifest.network || "").toLowerCase() !== net) {
    throw new AiIntegrationTaskError(`Manifest network mismatch: expected ${net}, got ${manifest.network}`);
  }
  if (String(manifest.sourceObject || "").toLowerCase() !== obj) {
    throw new AiIntegrationTaskError(
      `Manifest sourceObject mismatch: expected ${obj}, got ${manifest.sourceObject}`,
    );
  }

  const files = manifest.files || {};
  const bundle = {
    contractPointer: CONTRACT_POINTER,
    network: net,
    sourceObject: obj,
    manifest,
    targetContract: manifest.targetContract || null,
    sourceFixture: readJsonFile(join(dir, files.sourceFixture || "source.api.json")),
    mappingRows: readJsonFile(join(dir, files.mappingRows || "mapping.rows.json")),
    expectedCanonical: readJsonFile(join(dir, files.expectedCanonical || "canonical.expected.json")),
    testCases: manifest.testCases || files.testCases || null,
    fixtureDir: dir,
  };

  assertAiIntegrationTaskBundle(bundle);
  return bundle;
}

/**
 * Assert a Pointer 24 task bundle is complete and scoped to one network + one source object.
 */
export function assertAiIntegrationTaskBundle(bundle, { surface = "ai_integration" } = {}) {
  if (!bundle || typeof bundle !== "object") {
    throw new AiIntegrationTaskError("AI integration task bundle is required");
  }

  if (Array.isArray(bundle.networks) && bundle.networks.length > 1) {
    throw new AiIntegrationTaskError("Do not integrate multiple networks in one AI task", {
      code: "AI_TASK_MULTI_NETWORK",
      details: { networks: bundle.networks, surface },
    });
  }

  if (Array.isArray(bundle.sourceObjects) && bundle.sourceObjects.length > 1) {
    throw new AiIntegrationTaskError("Do not integrate multiple source objects in one AI task", {
      code: "AI_TASK_MULTI_SOURCE_OBJECT",
      details: { sourceObjects: bundle.sourceObjects, surface },
    });
  }

  const missing = [];
  for (const key of AI_TASK_REQUIRED_INPUTS) {
    const value = bundle[key];
    if (value == null || (typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length)) {
      missing.push(key);
    }
  }

  if (missing.length) {
    throw new AiIntegrationTaskError(
      `AI integration task missing required inputs: ${missing.join(", ")}`,
      { code: "AI_TASK_INPUTS_INCOMPLETE", details: { missing, surface } },
    );
  }

  if (!bundle.network || !bundle.sourceObject) {
    throw new AiIntegrationTaskError("AI integration task requires network and sourceObject scope");
  }

  return bundle;
}

export function applyAiIntegrationContract(response, { network, sourceObject } = {}) {
  if (!response || typeof response !== "object") return response;
  const meta = {
    ...(response.meta && typeof response.meta === "object" ? response.meta : {}),
    contractPointer: CONTRACT_POINTER,
    aiIntegrationNetwork: network || null,
    aiIntegrationSourceObject: sourceObject || null,
  };
  return { ...response, meta };
}

/** Layers AI tasks may touch — re-exported from Pointer 23. */
export { NETWORK_PLUG_IN_LAYERS };
