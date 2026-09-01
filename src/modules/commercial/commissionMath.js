export function deriveMboCommission(grossCommission, clientCommission) {
  const gross = Number(grossCommission);
  const client = Number(clientCommission);
  if (Number.isNaN(gross) || Number.isNaN(client)) {
    throw new Error("Invalid commission values.");
  }
  return (gross - client).toFixed(4);
}

export function periodsOverlap(startA, endA, startB, endB) {
  const aStart = new Date(startA).getTime();
  const aEnd = endA ? new Date(endA).getTime() : Number.POSITIVE_INFINITY;
  const bStart = new Date(startB).getTime();
  const bEnd = endB ? new Date(endB).getTime() : Number.POSITIVE_INFINITY;
  return aStart <= bEnd && bStart <= aEnd;
}
