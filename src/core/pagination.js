export function getPagination(query) {
  const page = Math.max(Number(query.page) || 1, 1);
  const pageSize = Math.min(Math.max(Number(query.pageSize) || 20, 1), 200);
  return { page, pageSize, skip: (page - 1) * pageSize, offset: (page - 1) * pageSize, limit: pageSize };
}

/** Phase 1 envelope — unchanged for existing entity/coupon dashboard clients. */
export function toPagedResponse({ rows, total, page, pageSize }) {
  return {
    page,
    pageSize,
    total,
    totalPages: Math.ceil(total / pageSize),
    data: rows,
  };
}

/** Wave 1+ standard envelope with optional cursor metadata. */
export function toStandardPagedResponse({ rows, total, page, pageSize, nextCursor, hasMore }) {
  return {
    ok: true,
    data: rows,
    pagination: {
      page: page ?? null,
      pageSize,
      total: total ?? null,
      totalPages: total == null ? null : Math.ceil(total / pageSize),
      nextCursor: nextCursor ?? null,
      hasMore: Boolean(hasMore),
    },
  };
}
