export function toNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return Number.isNaN(value) ? null : value;
  }

  const parsed = Number(String(value).replace(/,/g, "").trim());
  return Number.isNaN(parsed) ? null : parsed;
}

export function toInt(value) {
  const num = toNumber(value);
  return num === null ? null : Math.trunc(num);
}

export function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}
