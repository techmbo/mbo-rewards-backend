import { Prisma } from "@prisma/client";

function jsonText(jsonColumn, path) {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) {
    return Prisma.sql`NULL`;
  }

  if (segments.length === 1) {
    return Prisma.sql`${Prisma.raw(`"${jsonColumn}"->>'${segments[0]}'`)}`;
  }

  const accessors = segments
    .map((segment, index) => (index === segments.length - 1 ? `->>'${segment}'` : `->'${segment}'`))
    .join("");

  return Prisma.raw(`"${jsonColumn}"${accessors}`);
}

function asNumeric(expr) {
  return Prisma.sql`(
    CASE
      WHEN ${expr} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (${expr})::double precision
      ELSE NULL
    END
  )`;
}

export function sumFromJsonPaths(paths, jsonColumn = "rawData") {
  const branches = paths.map((path) => asNumeric(jsonText(jsonColumn, path)));
  return Prisma.sql`COALESCE(${Prisma.join(branches, ", ")}, 0)`;
}

export function sumColumn(paths) {
  return Prisma.sql`SUM(${sumFromJsonPaths(paths)})`;
}

export function sumStructuredColumn(columnName) {
  return Prisma.sql`SUM(COALESCE(${Prisma.raw(`"${columnName}"`)}, 0))`;
}
