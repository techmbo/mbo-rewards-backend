import fs from "node:fs";

const path = "prisma/schema.prisma";
let schema = fs.readFileSync(path, "utf8");

const oldEnum = `enum SupplierKey {\n  BOOSTINY\n  OPTIMISE\n  TRACKIER\n  PARTNERIZE\n  IMPACT\n  AWIN\n  UNKNOWN\n}`;
const newEnum = `enum SupplierKey {\n  BOOSTINY\n  OPTIMISE\n  TRACKIER\n  PARTNERIZE\n  IMPACT\n  AWIN\n  ADMITAD\n  CJ\n  RAKUTEN\n  UNKNOWN\n}`;

if (schema.includes(newEnum)) {
  console.log("SupplierKey enum already includes all nine MBO networks.");
  process.exit(0);
}

if (!schema.includes(oldEnum)) {
  throw new Error("Could not find expected SupplierKey enum anchor; inspect schema before changing it.");
}

schema = schema.replace(oldEnum, newEnum);
fs.writeFileSync(path, schema);
console.log("Expanded SupplierKey enum to ADMITAD, CJ, and RAKUTEN.");
