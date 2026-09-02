import fs from "node:fs";

const path = "src/modules/commercial/services/commercial.service.js";
let source = fs.readFileSync(path, "utf8");

source = source.replace('import { TIERED_NOT_IMPLEMENTED_MESSAGE } from "../validators/schemas.js";\n', "");
source = source.replace(
  /\/\*\* Epic 6-A — TIERED client rules cannot become EFFECTIVE \/ activatable\. \*\/\nfunction assertTieredNotActivatable\(commissionType\) \{[\s\S]*?\n\}\n\n/,
  "",
);

const classAnchor = "export class CommercialService {";
if (!source.includes("function commercialConditionSignature")) {
  const helpers = `function stableValue(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, stableValue(val)]));
  }
  return value;
}

function commercialConditionSignature(conditions = []) {
  const list = Array.isArray(conditions) ? conditions : [];
  const normalized = list
    .filter((condition) => String(condition?.conditionType || "").toUpperCase() !== "DEFAULT")
    .map((condition) => ({
      conditionType: String(condition.conditionType || "CUSTOM_FIELD").trim().toUpperCase(),
      operator: String(condition.operator || "EQ").trim().toUpperCase(),
      field: condition.field || null,
      value: stableValue(condition.value ?? null),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return normalized.length ? JSON.stringify(normalized) : "DEFAULT";
}

function assertCommercialActivationReady(rule) {
  if (!rule.agreementRef || !rule.agreementApprovedAt || !rule.agreementApprovedBy) {
    throw fail("Commercial agreement/IO/SOW approval lineage is required before activation.", 409);
  }
  if (String(rule.commissionType || "").toUpperCase() === "TIERED") {
    if (!rule.tierMetric || !rule.tierPeriod || !Array.isArray(rule.tiers) || !rule.tiers.length) {
      throw fail("TIERED rules require tierMetric, tierPeriod and at least one persisted tier.", 409);
    }
  }
  if (rule.subsidyApproved === true && (!rule.subsidyApprovalRef || !rule.subsidyApprovedAt || !rule.subsidyApprovedBy)) {
    throw fail("Approved subsidy requires approval reference, date and approver.", 409);
  }
}

async function closeSameLineagePredecessors(repo, rule, overlapping, client) {
  const signature = commercialConditionSignature(rule.conditions);
  for (const existing of overlapping) {
    if (commercialConditionSignature(existing.conditions) !== signature) continue;
    const existingStart = new Date(existing.effectiveFrom).getTime();
    const nextStart = new Date(rule.effectiveFrom).getTime();
    if (!Number.isFinite(existingStart) || !Number.isFinite(nextStart) || existingStart >= nextStart) {
      throw fail("An overlapping client commercial rule with the same conditions already exists.", 409);
    }
    await repo.update(
      existing.id,
      { status: "SUPERSEDED", effectiveUntil: rule.effectiveFrom },
      client,
    );
  }
}

`;
  source = source.replace(classAnchor, helpers + classAnchor);
}

const replacement = `  async createCommissionRule(input, client = null) {
    const commissionType = input.commissionType ?? "PERCENT";
    let gross = input.grossCommission;
    let clientShare = input.clientCommission;

    if (gross == null || clientShare == null) {
      if (commissionType === "FIXED_CLIENT_PERCENT_OF_ORDER_VALUE" || commissionType === "TIERED") {
        gross = gross ?? 100;
        clientShare = clientShare ?? 0;
      } else if (
        commissionType === "FIXED_CLIENT_AMOUNT_PER_CONFIRMED_ORDER" ||
        (commissionType === "FIXED" && input.fixedAmount != null)
      ) {
        const amt = Number(input.fixedAmount ?? 0);
        gross = gross ?? amt;
        clientShare = clientShare ?? amt;
      } else if (commissionType === "MANUAL_APPROVED_CLIENT_COMMISSION") {
        const amt = Number(input.manualAmount ?? 0);
        gross = gross ?? amt;
        clientShare = clientShare ?? amt;
      } else {
        throw fail("grossCommission and clientCommission are required for this rule type.", 400);
      }
    }

    const mboCommission = this.validateCommissionSplit(gross, clientShare);
    const manualApproved = Boolean(input.manualApproved);

    const run = async (tx) => {
      const assignment = await this.getAssignment(input.assignmentId, tx);
      assertCommercialAssignment(assignment);

      const ruleData = {
        assignmentId: input.assignmentId,
        grossCommission: gross,
        clientCommission: clientShare,
        mboCommission,
        commissionType,
        currency: input.currency ?? assignment.canonicalCampaign?.defaultCurrency ?? null,
        orderValuePercent: input.orderValuePercent ?? null,
        fixedAmount: input.fixedAmount ?? null,
        manualAmount: input.manualAmount ?? null,
        manualApproved,
        manualApprovedAt: manualApproved ? new Date() : null,
        manualApprovedBy: manualApproved ? input.manualApprovedBy ?? null : null,
        displayRangeMin: input.displayRangeMin ?? null,
        displayRangeMax: input.displayRangeMax ?? null,
        displayLabel: input.displayLabel ?? null,
        priority: input.priority ?? null,
        priorityVerified: Boolean(input.priorityVerified),
        agreementRef: input.agreementRef ?? null,
        agreementApprovedAt: input.agreementApprovedAt ?? null,
        agreementApprovedBy: input.agreementApprovedBy ?? null,
        subsidyApproved: Boolean(input.subsidyApproved),
        subsidyApprovalRef: input.subsidyApprovalRef ?? null,
        subsidyApprovedAt: input.subsidyApprovedAt ?? null,
        subsidyApprovedBy: input.subsidyApprovedBy ?? null,
        tierMetric: input.tierMetric ?? null,
        tierPeriod: input.tierPeriod ?? null,
        metadata: input.metadata ?? null,
        conditions: input.conditions ?? [],
        tiers: input.tiers ?? [],
        effectiveFrom: input.effectiveFrom,
        effectiveUntil: input.effectiveUntil ?? null,
        status: input.activate ? "EFFECTIVE" : "DRAFT",
      };

      if (input.activate) {
        assertCommercialActivationReady(ruleData);
        const overlapping = await this.commissionRepo.findOverlappingEffective(
          input.assignmentId,
          input.effectiveFrom,
          input.effectiveUntil ?? null,
          null,
          tx,
        );
        await closeSameLineagePredecessors(this.commissionRepo, ruleData, overlapping, tx);
      }

      return this.commissionRepo.create(ruleData, tx);
    };

    if (client) return run(client);
    return prisma.$transaction(run);
  }

  async activateCommissionRule(id, client = null) {
    const rule = await this.commissionRepo.findById(id, client);
    if (!rule) throw fail("Commission rule not found.", 404);
    if (rule.status === "SUPERSEDED") throw fail("Cannot activate a superseded rule.", 409);
    assertCommercialActivationReady(rule);

    const overlapping = await this.commissionRepo.findOverlappingEffective(
      rule.assignmentId,
      rule.effectiveFrom,
      rule.effectiveUntil,
      rule.id,
      client,
    );
    await closeSameLineagePredecessors(this.commissionRepo, rule, overlapping, client);
    return this.commissionRepo.update(id, { status: "EFFECTIVE" }, client);
  }

  async updateCommissionRule(id, input, client = null) {
    const rule = await this.commissionRepo.findById(id, client);
    if (!rule) throw fail("Commission rule not found.", 404);

    if (input.supersede) {
      return this.commissionRepo.update(
        id,
        { status: "SUPERSEDED", effectiveUntil: input.effectiveUntil ?? new Date() },
        client,
      );
    }

    const activateAfterUpdate = input.activate === true || String(input.status || "").toUpperCase() === "EFFECTIVE";
    const data = {};
    if (input.status !== undefined && !activateAfterUpdate) data.status = input.status;
    if (input.effectiveUntil !== undefined) data.effectiveUntil = input.effectiveUntil;
    if (input.orderValuePercent !== undefined) data.orderValuePercent = input.orderValuePercent;
    if (input.fixedAmount !== undefined) data.fixedAmount = input.fixedAmount;
    if (input.manualAmount !== undefined) data.manualAmount = input.manualAmount;
    if (input.displayRangeMin !== undefined) data.displayRangeMin = input.displayRangeMin;
    if (input.displayRangeMax !== undefined) data.displayRangeMax = input.displayRangeMax;
    if (input.displayLabel !== undefined) data.displayLabel = input.displayLabel;
    if (input.currency !== undefined) data.currency = input.currency;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.priorityVerified !== undefined) data.priorityVerified = Boolean(input.priorityVerified);
    if (input.agreementRef !== undefined) data.agreementRef = input.agreementRef;
    if (input.agreementApprovedAt !== undefined) data.agreementApprovedAt = input.agreementApprovedAt;
    if (input.agreementApprovedBy !== undefined) data.agreementApprovedBy = input.agreementApprovedBy;
    if (input.subsidyApproved !== undefined) data.subsidyApproved = Boolean(input.subsidyApproved);
    if (input.subsidyApprovalRef !== undefined) data.subsidyApprovalRef = input.subsidyApprovalRef;
    if (input.subsidyApprovedAt !== undefined) data.subsidyApprovedAt = input.subsidyApprovedAt;
    if (input.subsidyApprovedBy !== undefined) data.subsidyApprovedBy = input.subsidyApprovedBy;
    if (input.tierMetric !== undefined) data.tierMetric = input.tierMetric;
    if (input.tierPeriod !== undefined) data.tierPeriod = input.tierPeriod;
    if (input.metadata !== undefined) data.metadata = input.metadata;
    if (input.conditions !== undefined) data.conditions = input.conditions;
    if (input.tiers !== undefined) data.tiers = input.tiers;
    if (input.manualApproved !== undefined) {
      data.manualApproved = Boolean(input.manualApproved);
      if (data.manualApproved) {
        data.manualApprovedAt = new Date();
        data.manualApprovedBy = input.manualApprovedBy ?? rule.manualApprovedBy ?? null;
      } else {
        data.manualApprovedAt = null;
        data.manualApprovedBy = null;
      }
    }

    const updated = Object.keys(data).length
      ? await this.commissionRepo.update(id, data, client)
      : rule;
    if (activateAfterUpdate) return this.activateCommissionRule(updated.id, client);
    return updated;
  }
}`;

const commercialBlock = /  async createCommissionRule\(input, client = null\) \{[\s\S]*?\n  async updateCommissionRule\(id, input, client = null\) \{[\s\S]*?\n  \}\n\}/;
if (!commercialBlock.test(source)) {
  throw new Error("Could not locate CommercialService commission rule methods.");
}
source = source.replace(commercialBlock, replacement);

fs.writeFileSync(path, source);
console.log("Client commercial service integration patch applied.");
