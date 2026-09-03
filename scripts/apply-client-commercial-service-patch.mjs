import fs from "node:fs";

const servicePath = "src/modules/commercial/services/commercial.service.js";
let service = fs.readFileSync(servicePath, "utf8");

if (!service.includes("function stableConditionValue")) {
  service = service.replace(
    "function commercialConditionSignature(conditions = []) {",
    `function stableConditionValue(operator, value) {
  const normalized = stableValue(value);
  if (["IN", "NOT_IN"].includes(String(operator || "").toUpperCase()) && Array.isArray(normalized)) {
    return [...normalized].sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  }
  return normalized;
}

function commercialConditionSignature(conditions = []) {`,
  );
}

service = service.replace(
  "      value: stableValue(condition.value ?? null),",
  `      value: stableConditionValue(
        String(condition.operator || "EQ").trim().toUpperCase(),
        condition.value ?? null,
      ),`,
);

if (!service.includes("Manual-approved client commission requires explicit approval evidence")) {
  service = service.replace(
    `  if (rule.subsidyApproved === true && (!rule.subsidyApprovalRef || !rule.subsidyApprovedAt || !rule.subsidyApprovedBy)) {`,
    `  if (String(rule.commissionType || "").toUpperCase() === "MANUAL_APPROVED_CLIENT_COMMISSION") {
    if (rule.manualApproved !== true || !rule.manualApprovedAt || !rule.manualApprovedBy) {
      throw fail("Manual-approved client commission requires explicit approval evidence before activation.", 409);
    }
  }
  if (rule.subsidyApproved === true && (!rule.subsidyApprovalRef || !rule.subsidyApprovedAt || !rule.subsidyApprovedBy)) {`,
  );
}

service = service.replace(
  "        manualApprovedAt: manualApproved ? new Date() : null,",
  "        manualApprovedAt: manualApproved ? input.manualApprovedAt ?? null : null,",
);

service = service.replace(
  `    if (input.manualApproved !== undefined) {
      data.manualApproved = Boolean(input.manualApproved);
      if (data.manualApproved) {
        data.manualApprovedAt = new Date();
        data.manualApprovedBy = input.manualApprovedBy ?? rule.manualApprovedBy ?? null;
      } else {
        data.manualApprovedAt = null;
        data.manualApprovedBy = null;
      }
    }`,
  `    if (input.manualApprovedAt !== undefined && input.manualApproved === undefined) {
      data.manualApprovedAt = input.manualApprovedAt;
    }
    if (input.manualApprovedBy !== undefined && input.manualApproved === undefined) {
      data.manualApprovedBy = input.manualApprovedBy;
    }
    if (input.manualApproved !== undefined) {
      data.manualApproved = Boolean(input.manualApproved);
      if (data.manualApproved) {
        data.manualApprovedAt = input.manualApprovedAt ?? rule.manualApprovedAt ?? null;
        data.manualApprovedBy = input.manualApprovedBy ?? rule.manualApprovedBy ?? null;
      } else {
        data.manualApprovedAt = null;
        data.manualApprovedBy = null;
      }
    }`,
);

fs.writeFileSync(servicePath, service);

const validatorPath = "src/modules/commercial/validators/schemas.js";
let validators = fs.readFileSync(validatorPath, "utf8");

if (!validators.includes("function refineManualApprovalEvidence")) {
  validators = validators.replace(
    "function refineCommercialRule(data, ctx) {",
    `function refineManualApprovalEvidence(data, ctx) {
  if (data.manualApproved === true) {
    if (!data.manualApprovedAt || !data.manualApprovedBy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Manual approval requires manualApprovedAt and manualApprovedBy",
        path: ["manualApproved"],
      });
    }
  }
}

function refineCommercialRule(data, ctx) {
  refineManualApprovalEvidence(data, ctx);`,
  );
}

if (!validators.includes("Manual-approved commercial rules must be explicitly approved before activation")) {
  validators = validators.replace(
    `  if (data.activate === true) {
    if (!data.agreementRef) {`,
    `  if (data.activate === true) {
    if (type === "MANUAL_APPROVED_CLIENT_COMMISSION" && data.manualApproved !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Manual-approved commercial rules must be explicitly approved before activation",
        path: ["manualApproved"],
      });
    }
    if (!data.agreementRef) {`,
  );
}

validators = validators.replace(
  `    manualApproved: z.boolean().optional(),
    manualApprovedBy: z.string().max(200).optional().nullable(),`,
  `    manualApproved: z.boolean().optional(),
    manualApprovedAt: z.coerce.date().optional().nullable(),
    manualApprovedBy: z.string().max(200).optional().nullable(),`,
);

// The same field pair occurs in both create and update schemas; ensure the update schema is covered too.
const manualFieldNeedle = `    manualApproved: z.boolean().optional(),\n    manualApprovedBy: z.string().max(200).optional().nullable(),`;
validators = validators.replace(
  manualFieldNeedle,
  `    manualApproved: z.boolean().optional(),\n    manualApprovedAt: z.coerce.date().optional().nullable(),\n    manualApprovedBy: z.string().max(200).optional().nullable(),`,
);

if (validators.endsWith("  });\n")) {
  validators = validators.replace(
    /export const updateCommissionRuleBodySchema = z\n  \.object\(([\s\S]*?)\n  \}\);\n$/,
    (match) => match,
  );
}

// Add the focused partial-update approval refinement without applying create-only ratio rules.
if (!validators.includes(".superRefine(refineManualApprovalEvidence);\n")) {
  validators = validators.replace(
    `export const updateCommissionRuleBodySchema = z
  .object({`,
    `export const updateCommissionRuleBodySchema = z
  .object({`,
  );
  validators = validators.replace(
    /export const updateCommissionRuleBodySchema = z([\s\S]*?)\n  \}\);\n$/,
    (full) => full.replace(/\n  \}\);\n$/, "\n  })\n  .superRefine(refineManualApprovalEvidence);\n"),
  );
}

fs.writeFileSync(validatorPath, validators);
console.log("Client commercial approval and condition hardening patch applied.");
