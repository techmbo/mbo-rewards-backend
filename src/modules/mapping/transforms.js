/**
 * Controlled mapping transforms (Wave E).
 * Never eval() config — only registered transform names.
 */

import { toNumber } from "../../core/normalize.js";

export const TRANSFORM_NAMES = Object.freeze([
  "STRING",
  "NUMBER",
  "BOOLEAN",
  "DATE",
  "CURRENCY",
  "ENUM",
  "ARRAY",
  "OBJECT",
  "PATH",
  "CONCAT",
  "COALESCE",
  "IDENTITY",
]);

/** @type {Map<string, Function>} */
const CUSTOM = new Map();

export function registerTransform(name, fn) {
  if (!name || typeof fn !== "function") {
    throw new Error("registerTransform requires name and function");
  }
  const key = String(name).toUpperCase();
  if (TRANSFORM_NAMES.includes(key) && key !== "IDENTITY") {
    throw new Error(`Cannot override built-in transform ${key}`);
  }
  CUSTOM.set(key, fn);
}

export function getValueAtPath(obj, path) {
  if (path == null || path === "") return obj;
  const parts = String(path).split(".");
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    // Support array index notation foo[0]
    const m = part.match(/^([^\[\]]+)(?:\[(\d+)\])?$/);
    if (!m) return undefined;
    cur = cur[m[1]];
    if (m[2] != null) {
      cur = Array.isArray(cur) ? cur[Number(m[2])] : undefined;
    }
  }
  return cur;
}

function asString(value) {
  if (value === undefined || value === null) return null;
  return String(value);
}

function asBoolean(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(s)) return true;
  if (["false", "0", "no", "n"].includes(s)) return false;
  return null;
}

function asDate(value) {
  if (value === undefined || value === null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function asCurrency(value) {
  const s = asString(value);
  if (!s) return null;
  return s.trim().toUpperCase();
}

function asEnum(value, options = {}) {
  const s = asString(value);
  if (s == null) return null;
  const map = options.map || options.enumMap || {};
  const upper = s.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(map, s)) return map[s];
  if (Object.prototype.hasOwnProperty.call(map, upper)) return map[upper];
  if (options.allowed) {
    const allowed = options.allowed.map((v) => String(v).toUpperCase());
    if (!allowed.includes(upper)) {
      const err = new Error(`Unknown enum value: ${s}`);
      err.code = "MAPPING_UNKNOWN_ENUM";
      throw err;
    }
  }
  return options.uppercase === false ? s : upper;
}

/**
 * Apply a named transform.
 */
export function applyTransform(name, value, options = {}, context = {}) {
  const key = String(name || "IDENTITY").toUpperCase();

  if (CUSTOM.has(key)) {
    return CUSTOM.get(key)(value, options, context);
  }

  switch (key) {
    case "IDENTITY":
    case "PATH":
    case "OBJECT":
      return value === undefined ? null : value;
    case "STRING":
      return asString(value);
    case "NUMBER": {
      if (value === undefined || value === null || value === "") return null;
      const n = toNumber(value);
      return n;
    }
    case "BOOLEAN":
      return asBoolean(value);
    case "DATE":
      return asDate(value);
    case "CURRENCY":
      return asCurrency(value);
    case "ENUM":
      return asEnum(value, options);
    case "ARRAY":
      if (value == null) return [];
      return Array.isArray(value) ? value : [value];
    case "CONCAT": {
      const parts = (options.paths || options.sources || [])
        .map((p) => getValueAtPath(context.source, p))
        .filter((v) => v != null && v !== "");
      const sep = options.separator ?? "";
      return parts.length ? parts.map(asString).join(sep) : null;
    }
    case "COALESCE": {
      const paths = options.paths || options.sources || [];
      for (const p of paths) {
        const v = getValueAtPath(context.source, p);
        if (v !== undefined && v !== null && v !== "") return v;
      }
      return value !== undefined && value !== null && value !== "" ? value : null;
    }
    default: {
      const err = new Error(`Unknown transform: ${name}`);
      err.code = "MAPPING_INVALID_TRANSFORM";
      throw err;
    }
  }
}

/**
 * Set nested target field (dot path).
 */
export function setValueAtPath(target, path, value) {
  const parts = String(path).split(".");
  let cur = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
  return target;
}
