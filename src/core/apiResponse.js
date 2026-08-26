export function ok(data, meta = {}) {
  return { ok: true, data, ...meta };
}

export function okPaged({ data, pagination }) {
  return {
    ok: true,
    data,
    pagination,
  };
}

export function okSummary(summary) {
  return { ok: true, summary };
}

export function fail(message, status = 400) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
}
