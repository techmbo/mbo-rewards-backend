/**
 * Parse YYYY-MM-DD query params into UTC day boundaries for inclusive filtering.
 */
export function parseDateRangeQuery({ fromDate, toDate } = {}) {
  const from = parseBoundaryDate(fromDate, false);
  const to = parseBoundaryDate(toDate, true);

  if (from && to && from.getTime() > to.getTime()) {
    return { fromDate: to, toDate: from, inverted: true };
  }

  return { fromDate: from, toDate: to, inverted: false };
}

function parseBoundaryDate(value, endOfDay) {
  if (value === null || value === undefined || value === "") return null;

  const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;

  if (endOfDay) {
    return new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
  }

  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

export function buildEventDateFilter({ fromDate, toDate, entityType } = {}) {
  if (!fromDate && !toDate) return null;

  const range = {
    ...(fromDate ? { gte: fromDate } : {}),
    ...(toDate ? { lte: toDate } : {}),
  };

  if (entityType === "campaign") {
    return {
      OR: [{ eventDate: range }, { eventDate: null, createdAt: range }],
    };
  }

  return { eventDate: range };
}
