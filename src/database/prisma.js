import { PrismaClient } from "@prisma/client";

/**
 * The runtime Prisma client, and which URL it connects with.
 *
 * TEMPORARY FALLBACK. Remove it once DATABASE_URL holds a valid connection string again; the client
 * construction then goes back to `new PrismaClient()`.
 *
 * DATABASE_URL was deleted during an incident and replaced with a value that is not a Postgres URL,
 * so Prisma's engine rejects it before any connection is attempted: "the URL must start with the
 * protocol postgresql:// or postgres://". DIRECT_URL was untouched and has been confirmed to name
 * the original database. Preferring it when DATABASE_URL is unusable restores the application
 * without anyone having to handle the secret.
 *
 * Two properties this file is careful about:
 *
 *  - **Nothing is normalised.** The raw environment value is tested with a strict prefix check and
 *    then used verbatim. Trimming a malformed value would silently "fix" the exact class of
 *    breakage that caused this incident — a quoted or whitespace-prefixed URL would start working
 *    here while still failing every other tool that reads the variable, which hides the fault
 *    instead of surfacing it.
 *  - **No URL is ever logged or exported.** Only the NAME of the variable that was selected leaves
 *    this module. A name is not a secret; a connection string is.
 */

/**
 * Whether a value is usable as a Prisma Postgres URL.
 *
 * The prefix test is deliberately the same rule Prisma's own engine applies, checked against the
 * raw string. `new URL()` would be the wrong tool: it strips leading whitespace, so it accepts
 * " postgresql://…" — a value the engine rejects. Agreeing with the engine matters more than being
 * lenient, because a disagreement means this file selects a value that cannot connect.
 */
export function isValidPostgresUrl(value) {
  return (
    typeof value === "string" &&
    (value.startsWith("postgresql://") || value.startsWith("postgres://"))
  );
}

/** Env var names, in preference order. DATABASE_URL always wins when it is usable. */
export const RUNTIME_DATABASE_URL_CANDIDATES = Object.freeze(["DATABASE_URL", "DIRECT_URL"]);

/**
 * Which environment variable the runtime client should connect with.
 *
 * Returns the NAME, not the value, so a caller can report or assert on the choice without ever
 * holding a connection string. `null` means neither candidate is usable — in which case the client
 * is constructed with no datasource override at all, so Prisma produces exactly the error it
 * produced before this fallback existed. Failing the same way is the point: this change must not
 * turn a configuration error into a different, less recognisable one.
 */
export function resolveRuntimeDatabaseUrlSource(env = process.env) {
  return RUNTIME_DATABASE_URL_CANDIDATES.find((name) => isValidPostgresUrl(env[name])) ?? null;
}

/** The name of the variable in use, or null. Never the value. Exported for diagnostics only. */
export const RUNTIME_DATABASE_URL_SOURCE = resolveRuntimeDatabaseUrlSource();

/**
 * One client, constructed once.
 *
 * With a usable candidate it carries an explicit datasource override; with none it is constructed
 * exactly as before — `new PrismaClient()` — preserving the previous failure behaviour verbatim
 * rather than substituting an override of `undefined`.
 */
export const prisma = RUNTIME_DATABASE_URL_SOURCE
  ? new PrismaClient({
      datasources: { db: { url: process.env[RUNTIME_DATABASE_URL_SOURCE] } },
    })
  : new PrismaClient();
