-- Expand the canonical supplier enum to the full nine-network MBO set.
-- Additive only: existing SupplierKey values and rows are preserved.
ALTER TYPE "SupplierKey" ADD VALUE IF NOT EXISTS 'ADMITAD';
ALTER TYPE "SupplierKey" ADD VALUE IF NOT EXISTS 'CJ';
ALTER TYPE "SupplierKey" ADD VALUE IF NOT EXISTS 'RAKUTEN';
