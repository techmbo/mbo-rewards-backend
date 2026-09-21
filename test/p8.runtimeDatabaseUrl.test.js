import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

process.env.BACKEND_URL = process.env.BACKEND_URL || "https://backend.test";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "https://frontend.test";

const {
  RUNTIME_DATABASE_URL_CANDIDATES,
  isValidPostgresUrl,
  resolveRuntimeDatabaseUrlSource,
} = await import("../src/database/prisma.js");

const prismaSource = readFileSync("src/database/prisma.js", "utf8");
/** Comments strip out: prose naming a variable must not satisfy a code assertion. */
const prismaCode = prismaSource.replace(/^\s*\*.*$/gm, "").replace(/\/\/.*$/gm, "");

/** Distinctive values so a leak assertion can name the string itself. */
const PRIMARY = "postgresql://zzprimaryuserzz:zzprimarypwzz@zzprimaryhostzz:5432/zzprimarydbzz";
const FALLBACK = "postgresql://zzfallbackuserzz:zzfallbackpwzz@zzfallbackhostzz:5432/zzfallbackdbzz";

/** Every shape of malformation this incident produced, plus the near-misses. */
const MALFORMED = {
  "not a url": "not-a-postgres-url",
  "quoted": `"${PRIMARY}"`,
  "leading space": ` ${PRIMARY}`,
  "leading newline": `\n${PRIMARY}`,
  "psql DSN": "host=zzprimaryhostzz port=5432 user=u password=p dbname=x",
  "bare api key": "eyJhbGciOiJIUzI1NiJ9.zzpayloadzz.zzsigzz",
  "prisma+postgres": "prisma+postgres://accelerate.prisma-data.net/?api_key=zzkeyzz",
  "mysql": "mysql://u:p@h:3306/db",
  "uppercase scheme": PRIMARY.replace("postgresql://", "POSTGRESQL://"),
  "empty": "",
  "whitespace only": "   ",
};

/** A frozen env object, so nothing here can touch the real process environment. */
function env(overrides) {
  return { ...overrides };
}

describe("runtime database URL — selection", () => {
  it("1 — a valid DATABASE_URL is preferred", () => {
    assert.equal(
      resolveRuntimeDatabaseUrlSource(env({ DATABASE_URL: PRIMARY, DIRECT_URL: FALLBACK })),
      "DATABASE_URL",
    );
    // Both schemes are accepted, and preference does not depend on which one is used.
    assert.equal(
      resolveRuntimeDatabaseUrlSource(
        env({ DATABASE_URL: PRIMARY.replace("postgresql://", "postgres://"), DIRECT_URL: FALLBACK }),
      ),
      "DATABASE_URL",
    );
  });

  it("2 — a malformed DATABASE_URL falls back to DIRECT_URL", () => {
    for (const [label, broken] of Object.entries(MALFORMED)) {
      assert.equal(
        resolveRuntimeDatabaseUrlSource(env({ DATABASE_URL: broken, DIRECT_URL: FALLBACK })),
        "DIRECT_URL",
        `no fallback for a ${label} DATABASE_URL`,
      );
    }
  });

  it("3 — a missing DATABASE_URL falls back to DIRECT_URL", () => {
    for (const missing of [undefined, null, 0, false, {}, []]) {
      assert.equal(
        resolveRuntimeDatabaseUrlSource(env({ DATABASE_URL: missing, DIRECT_URL: FALLBACK })),
        "DIRECT_URL",
        `no fallback for DATABASE_URL = ${String(missing)}`,
      );
    }
    assert.equal(resolveRuntimeDatabaseUrlSource(env({ DIRECT_URL: FALLBACK })), "DIRECT_URL");
  });

  it("4 — a valid DATABASE_URL is never replaced, whatever DIRECT_URL holds", () => {
    for (const direct of [FALLBACK, undefined, "", "not-a-url", `"${FALLBACK}"`]) {
      assert.equal(
        resolveRuntimeDatabaseUrlSource(env({ DATABASE_URL: PRIMARY, DIRECT_URL: direct })),
        "DATABASE_URL",
        `a valid DATABASE_URL was displaced by DIRECT_URL = ${String(direct)}`,
      );
    }
  });

  it("4b — neither usable means no override, preserving the previous failure", () => {
    for (const [label, broken] of Object.entries(MALFORMED)) {
      assert.equal(
        resolveRuntimeDatabaseUrlSource(env({ DATABASE_URL: broken, DIRECT_URL: broken })),
        null,
        `${label} produced a selection it should not have`,
      );
    }
    assert.equal(resolveRuntimeDatabaseUrlSource(env({})), null);
    // A null source means the client is built with no datasource argument at all.
    assert.match(prismaCode, /RUNTIME_DATABASE_URL_SOURCE\s*\n?\s*\?/);
    assert.match(prismaCode, /:\s*new PrismaClient\(\);/);
  });

  it("4c — validation is a strict raw-prefix test, matching Prisma's own engine", () => {
    assert.equal(isValidPostgresUrl(PRIMARY), true);
    assert.equal(isValidPostgresUrl("postgres://u:p@h:5432/d"), true);
    for (const broken of Object.values(MALFORMED)) assert.equal(isValidPostgresUrl(broken), false);
    for (const notAString of [undefined, null, 42, {}, [], () => {}]) {
      assert.equal(isValidPostgresUrl(notAString), false);
    }
    // No trimming, no normalising: a leading space stays invalid, as the engine treats it.
    assert.equal(isValidPostgresUrl(` ${PRIMARY}`), false);
    assert.ok(!prismaCode.includes(".trim()"), "the selector trims a value");
    assert.ok(!prismaCode.includes("new URL("), "the selector parses instead of prefix-testing");
    assert.ok(!prismaCode.includes(".replace("), "the selector rewrites a value");
  });

  it("4d — order of preference is declared, not incidental", () => {
    assert.deepEqual([...RUNTIME_DATABASE_URL_CANDIDATES], ["DATABASE_URL", "DIRECT_URL"]);
    assert.ok(Object.isFrozen(RUNTIME_DATABASE_URL_CANDIDATES));
  });
});

describe("runtime database URL — nothing escapes", () => {
  it("5 — the selector returns a variable NAME, never a URL", () => {
    const cases = [
      { DATABASE_URL: PRIMARY, DIRECT_URL: FALLBACK },
      { DATABASE_URL: "not-a-url", DIRECT_URL: FALLBACK },
      { DATABASE_URL: `"${PRIMARY}"`, DIRECT_URL: FALLBACK },
      {},
    ];
    for (const scenario of cases) {
      const source = resolveRuntimeDatabaseUrlSource(env(scenario));
      assert.ok(source === null || RUNTIME_DATABASE_URL_CANDIDATES.includes(source));
      for (const secret of ["zzprimary", "zzfallback", "postgresql://", "postgres://", "@"]) {
        assert.ok(!String(source).includes(secret), `the selector returned ${secret}`);
      }
    }
  });

  it("5b — no URL is logged: the module has no logger and no console call", () => {
    for (const forbidden of ["console.", "logger", "childLogger", "process.stdout", "process.stderr"]) {
      assert.ok(!prismaCode.includes(forbidden), `the module writes output via ${forbidden}`);
    }
    // And nothing pulls the logger in.
    assert.equal(prismaCode.split("import ").length - 1, 1, "one import only");
    assert.match(prismaCode, /import \{ PrismaClient \} from "@prisma\/client";/);
  });

  it("5c — selecting a source produces no output on stdout or stderr", () => {
    const chunks = [];
    const patch = (stream) => {
      const original = stream.write;
      stream.write = (chunk, ...rest) => {
        chunks.push(String(chunk));
        return original.call(stream, chunk, ...rest);
      };
      return () => {
        stream.write = original;
      };
    };
    const restoreOut = patch(process.stdout);
    const restoreErr = patch(process.stderr);
    try {
      resolveRuntimeDatabaseUrlSource(env({ DATABASE_URL: "not-a-url", DIRECT_URL: FALLBACK }));
      isValidPostgresUrl(PRIMARY);
    } finally {
      restoreOut();
      restoreErr();
    }
    assert.equal(chunks.join(""), "", "the selector wrote to a stream");
  });

  it("5d — the exported source name is a name, and the URL itself is not exported", async () => {
    const module = await import("../src/database/prisma.js");
    const exported = Object.keys(module).sort();
    assert.deepEqual(exported, [
      "RUNTIME_DATABASE_URL_CANDIDATES",
      "RUNTIME_DATABASE_URL_SOURCE",
      "isValidPostgresUrl",
      "prisma",
      "resolveRuntimeDatabaseUrlSource",
    ]);
    const source = module.RUNTIME_DATABASE_URL_SOURCE;
    assert.ok(source === null || RUNTIME_DATABASE_URL_CANDIDATES.includes(source));
    // Assert on VALUES, not names: `isValidPostgresUrl` is a predicate, not a connection string.
    // No exported string may look like one.
    for (const [name, value] of Object.entries(module)) {
      const strings = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
      for (const text of strings) {
        assert.ok(!text.includes("://"), `export ${name} holds a URL`);
        assert.ok(!text.includes("@"), `export ${name} holds a credential-shaped string`);
      }
    }
  });
});

describe("runtime database URL — nothing else changed", () => {
  it("6 — no write is introduced: the module only constructs a client", () => {
    for (const forbidden of [
      "$executeRaw",
      "$queryRaw",
      "$transaction",
      "$connect",
      ".create(",
      ".update(",
      ".upsert(",
      ".delete(",
      "INSERT",
      "UPDATE",
      "DELETE",
      "migrate",
      "db push",
    ]) {
      assert.ok(!prismaCode.includes(forbidden), `the module does ${forbidden}`);
    }
    // Exactly one client is constructed on each branch, and nothing else runs at import.
    assert.equal(prismaCode.split("new PrismaClient(").length - 1, 2, "one per branch");
  });

  it("6b — the client is still a single shared instance with the same export name", () => {
    assert.match(prismaCode, /export const prisma =/);
    assert.equal(prismaCode.split("export const prisma").length - 1, 1);
  });

  it("6c — schema.prisma and migration configuration are untouched", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    assert.match(schema, /url\s+= env\("DATABASE_URL"\)/);
    assert.match(schema, /directUrl = env\("DIRECT_URL"\)/);
    assert.match(schema, /provider\s+= "postgresql"/);
    const lock = readFileSync("prisma/migrations/migration_lock.toml", "utf8");
    assert.match(lock, /provider = "postgresql"/);
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    assert.equal(pkg.scripts.build, "prisma generate");
    assert.equal(pkg.scripts.prisma_migrate ?? pkg.scripts["prisma:migrate"], "prisma migrate dev");
  });

  it("6d — the fallback is confined to this one file", () => {
    // No other runtime module picks a URL: the metrics layer reuses the shared client from
    // prisma.js rather than resolving a URL of its own.
    const metrics = readFileSync("src/database/prismaMetrics.js", "utf8");
    assert.match(metrics, /import \{ prisma \} from "\.\/prisma\.js";/);
    assert.match(metrics, /export function attachPrismaMetrics\(client = prisma\)/);
  });

  it("6e — the fallback is documented as temporary", () => {
    assert.match(prismaSource, /TEMPORARY FALLBACK/);
  });
});
