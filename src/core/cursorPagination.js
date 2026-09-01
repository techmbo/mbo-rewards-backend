export function encodeCursor(record, fields = ["id"]) {
  const payload = {};
  for (const field of fields) {
    payload[field] = record[field] instanceof Date ? record[field].toISOString() : record[field];
  }
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeCursor(cursor, fields = ["id"]) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const decoded = {};
    for (const field of fields) {
      if (parsed[field] === undefined) return null;
      decoded[field] =
        field.endsWith("At") || field.endsWith("Date") ? new Date(parsed[field]) : parsed[field];
    }
    return decoded;
  } catch {
    return null;
  }
}

export function buildCursorWhere(cursor, orderFields) {
  if (!cursor) return {};

  const [primary, secondary = "id"] = orderFields;
  const primaryValue = cursor[primary];
  const secondaryValue = cursor[secondary];

  return {
    OR: [
      { [primary]: { lt: primaryValue } },
      { [primary]: primaryValue, [secondary]: { lt: secondaryValue } },
    ],
  };
}

export function slicePage(rows, take) {
  const hasMore = rows.length > take;
  return {
    rows: hasMore ? rows.slice(0, take) : rows,
    hasMore,
  };
}
