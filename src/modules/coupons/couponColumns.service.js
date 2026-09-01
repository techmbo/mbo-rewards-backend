import { prisma } from "../../database/prisma.js";
import { DEFAULT_COUPON_COLUMNS } from "./defaultColumns.js";

function toClientColumn(row) {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    sortOrder: row.sortOrder,
    visible: row.visible,
    sourceType: row.sourceType,
    dataPath: row.dataPath,
    optimisePaths: row.optimisePaths,
    boostinyPaths: row.boostinyPaths,
    columnType: row.columnType,
    builtinKey: row.builtinKey,
  };
}

export async function ensureDefaultCouponColumns() {
  const count = await prisma.couponColumnConfig.count();
  if (count > 0) return;

  await prisma.couponColumnConfig.createMany({
    data: DEFAULT_COUPON_COLUMNS.map((column) => ({
      key: column.key,
      label: column.label,
      sortOrder: column.sortOrder,
      visible: column.visible,
      sourceType: column.sourceType,
      dataPath: column.dataPath ?? null,
      optimisePaths: column.optimisePaths ?? [],
      boostinyPaths: column.boostinyPaths ?? [],
      columnType: column.columnType ?? "text",
      builtinKey: column.builtinKey ?? null,
    })),
  });
}

export async function listCouponColumns({ includeHidden = true } = {}) {
  await ensureDefaultCouponColumns();

  const rows = await prisma.couponColumnConfig.findMany({
    where: includeHidden ? {} : { visible: true },
    orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
  });

  return rows.map(toClientColumn);
}

export async function createCouponColumn(payload) {
  const key = String(payload.key || "")
    .trim()
    .replace(/\s+/g, "_");
  if (!key) throw new Error("Column key is required");

  const maxOrder = await prisma.couponColumnConfig.aggregate({
    _max: { sortOrder: true },
  });

  const row = await prisma.couponColumnConfig.create({
    data: {
      key,
      label: String(payload.label || key).trim(),
      sortOrder: Number.isFinite(payload.sortOrder) ? payload.sortOrder : (maxOrder._max.sortOrder ?? 0) + 1,
      visible: payload.visible !== false,
      sourceType: payload.sourceType || "custom",
      dataPath: payload.dataPath ? String(payload.dataPath) : key,
      optimisePaths: payload.optimisePaths || [],
      boostinyPaths: payload.boostinyPaths || [],
      columnType: payload.columnType || "text",
      builtinKey: payload.builtinKey ?? null,
    },
  });

  return toClientColumn(row);
}

export async function updateCouponColumn(key, payload) {
  const row = await prisma.couponColumnConfig.update({
    where: { key },
    data: {
      ...(payload.label !== undefined ? { label: String(payload.label) } : {}),
      ...(payload.sortOrder !== undefined ? { sortOrder: Number(payload.sortOrder) } : {}),
      ...(payload.visible !== undefined ? { visible: Boolean(payload.visible) } : {}),
      ...(payload.sourceType !== undefined ? { sourceType: String(payload.sourceType) } : {}),
      ...(payload.dataPath !== undefined ? { dataPath: payload.dataPath ? String(payload.dataPath) : null } : {}),
      ...(payload.optimisePaths !== undefined ? { optimisePaths: payload.optimisePaths } : {}),
      ...(payload.boostinyPaths !== undefined ? { boostinyPaths: payload.boostinyPaths } : {}),
      ...(payload.columnType !== undefined ? { columnType: String(payload.columnType) } : {}),
      ...(payload.builtinKey !== undefined ? { builtinKey: payload.builtinKey } : {}),
    },
  });

  return toClientColumn(row);
}

export async function deleteCouponColumn(key) {
  await prisma.couponColumnConfig.delete({ where: { key } });
  return { ok: true };
}

export async function replaceCouponColumns(columns = []) {
  await prisma.$transaction(async (tx) => {
    await tx.couponColumnConfig.deleteMany();

    if (columns.length === 0) {
      await tx.couponColumnConfig.createMany({
        data: DEFAULT_COUPON_COLUMNS.map((column) => ({
          key: column.key,
          label: column.label,
          sortOrder: column.sortOrder,
          visible: column.visible,
          sourceType: column.sourceType,
          dataPath: column.dataPath ?? null,
          optimisePaths: column.optimisePaths ?? [],
          boostinyPaths: column.boostinyPaths ?? [],
          columnType: column.columnType ?? "text",
          builtinKey: column.builtinKey ?? null,
        })),
      });
      return;
    }

    await tx.couponColumnConfig.createMany({
      data: columns.map((column, index) => ({
        key: column.key,
        label: column.label,
        sortOrder: Number.isFinite(column.sortOrder) ? column.sortOrder : index,
        visible: column.visible !== false,
        sourceType: column.sourceType || "custom",
        dataPath: column.dataPath ?? column.key,
        optimisePaths: column.optimisePaths || [],
        boostinyPaths: column.boostinyPaths || [],
        columnType: column.columnType || "text",
        builtinKey: column.builtinKey ?? null,
      })),
    });
  });

  return listCouponColumns();
}

export async function resetCouponColumns() {
  return replaceCouponColumns([]);
}
