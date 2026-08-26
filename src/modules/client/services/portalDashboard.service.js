import { prisma } from "../../../database/prisma.js";
import { fail } from "../../../core/apiResponse.js";
import { encryptSecret } from "../../../platform/security/encryption.js";
import { PartnerCampaignService } from "./partnerCampaign.service.js";
import { toPartnerClientSummaryDto } from "../dto/partnerCampaign.dto.js";
import {
  FinanceConsumerService,
  FINANCE_CONSUMER_MODES,
} from "../../finance/financeConsumer.service.js";
import { auditService } from "../../../platform/audit/audit.service.js";

function money(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(4)) : 0;
}

function clientCommissionAmount(conversion) {
  // Wave A: never fall back to supplier/approved commission as client earnings.
  if (String(conversion?.status || "").toUpperCase() === "REJECTED") {
    return 0;
  }
  if (conversion.clientCommission != null && conversion.clientCommission !== "") {
    return money(conversion.clientCommission);
  }
  return 0;
}

function bankEncKey() {
  return process.env.OAUTH_TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET;
}

function newWithdrawalRef() {
  const n = Math.floor(1000 + Math.random() * 9000);
  return `WD-${n}`;
}

/**
 * Tenant-scoped client portal dashboard (overview, performance, payments, support, settings).
 * Client id always comes from authenticated credentials — never request params.
 */
export class PortalDashboardService {
  constructor(deps = {}) {
    this.partnerCampaigns = deps.partnerCampaigns ?? new PartnerCampaignService();
    this.prisma = deps.prisma ?? prisma;
    this.financeConsumer = deps.financeConsumer ?? new FinanceConsumerService({ prisma: this.prisma });
    this.clientReporting = deps.clientReporting ?? null;
    this.audit = deps.audit ?? auditService;
  }

  async assertClient(clientId) {
    return this.partnerCampaigns.assertPartnerClient(clientId);
  }

  async getMe(clientId, user = null) {
    const client = await this.assertClient(clientId);
    const bank = await this.prisma.clientBankAccount.findUnique({ where: { clientId } });
    return {
      client: toPartnerClientSummaryDto(client),
      bankStatus: bank ? bank.status : "NOT_ADDED",
      user: user
        ? {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
          }
        : null,
    };
  }

  async getOverview(clientId) {
    const client = await this.assertClient(clientId);
    // Probe pagination.total from canonical PartnerCampaignService (same visibility filters),
    // then load the full page window so KPIs are not capped at 100.
    const probe = await this.partnerCampaigns.listCampaigns(clientId, { page: 1, pageSize: 1 });
    const repoTotal =
      probe?.pagination?.total != null && Number.isFinite(Number(probe.pagination.total))
        ? Number(probe.pagination.total)
        : null;
    const fetchSize =
      repoTotal != null ? Math.min(Math.max(repoTotal, 1), 2000) : 100;
    const [campaignsPayload, performance, payments] = await Promise.all([
      fetchSize <= 1
        ? Promise.resolve(probe)
        : this.partnerCampaigns.listCampaigns(clientId, { page: 1, pageSize: fetchSize }),
      this.getPerformance(clientId, { pageSize: 200 }),
      this.getPaymentsSummary(clientId),
    ]);

    const campaigns = campaignsPayload.campaigns || [];
    // Same population as GET /api/v1/client/campaigns after PartnerCampaignService projection.
    const liveCount = campaigns.filter(
      (c) =>
        String(c.assignmentStatus || "").toUpperCase() === "CLIENT_VISIBLE" ||
        c.displayStatus === "Live",
    ).length;
    const pausedCount = campaigns.filter(
      (c) =>
        String(c.assignmentStatus || "").toUpperCase() === "PAUSED" ||
        c.displayStatus === "Paused",
    ).length;
    const newCount = campaigns.filter((c) => c.isNew).length;
    // Prefer projected page length (client-visible). When the full repo window was fetched,
    // this equals the full visible population — not the first 100 only.
    const totalVisible = campaigns.length;
    const rows = performance.rows || [];
    const perfKpis = performance.kpis || {};
    const perfAvailable = performance.dataAvailable === true;
    // Backend-authoritative KPIs — do not invent zeros when empty.
    const clicks = perfAvailable ? perfKpis.linkClicks : null;
    const orderValue = perfAvailable
      ? perfKpis.netOrderValue != null
        ? perfKpis.netOrderValue
        : null
      : null;
    const top = [...rows]
      .sort((a, b) => (Number(b.approvedCommission) || 0) - (Number(a.approvedCommission) || 0))
      .slice(0, 5);

    return {
      client: toPartnerClientSummaryDto(client),
      bankStatus: (await this.prisma.clientBankAccount.findUnique({ where: { clientId } }))?.status || "NOT_ADDED",
      kpis: {
        /** Client-visible (Live) campaigns — same source as campaign list. */
        activeCampaigns: liveCount,
        /** Full client-visible population from PartnerCampaignService (not pageSize-capped). */
        totalCampaigns: totalVisible,
        pausedCampaigns: pausedCount,
        newlyAssigned: newCount,
        clicks,
        orderValue,
        performanceDataAvailable: perfAvailable,
        availableToWithdraw: payments.kpis.available,
        /** Honest null when client has no currency configured — UI must not invent INR. */
        currency: client.currency || payments.currency || null,
        campaignPopulation: "client_api_visible",
        campaignPopulationNote:
          "Campaign KPIs use PartnerCampaignService full visible population (pagination.total drives fetch size; projected campaigns.length is the KPI).",
        campaignRepoTotal: repoTotal,
        performancePopulation: "client_api_daily_report",
      },
      topPerformance: top,
      paymentFlow: [
        { step: 1, title: "Conversion received", detail: "Order or action is tracked." },
        { step: 2, title: "Supplier confirms", detail: "Commission becomes approved." },
        { step: 3, title: "Client withdraws", detail: "Request from Payments." },
        { step: 4, title: "MBO pays", detail: "Payment moves to Paid." },
      ],
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Daily performance for this client — delegates to ClientReportingService
   * (same DailyReport grain as GET /v1/client/performance). No second engine.
   */
  async getPerformance(clientId, query = {}) {
    if (!this.clientReporting) {
      const { ClientReportingService } = await import("./clientReporting.service.js");
      this.clientReporting = new ClientReportingService({
        prisma: this.prisma,
        partnerCampaigns: this.partnerCampaigns,
        financeConsumer: this.financeConsumer,
      });
    }
    return this.clientReporting.listPerformance(clientId, query);
  }

  emptyPerfKpis() {
    return {
      linkClicks: null,
      grossOrders: null,
      clientCommission: null,
      pendingClientCommission: null,
      orderValue: null,
      approvedCommission: null,
      pendingCommission: null,
      clicks: null,
    };
  }

  async getPaymentsSummary(clientId) {
    const client = await this.assertClient(clientId);

    const assignmentRows = await this.prisma.clientCampaignAssignment.findMany({
      where: { clientId, status: { not: "REVOKED" } },
      include: { canonicalCampaign: { include: { merchant: true } } },
    });

    const ids = assignmentRows.map((a) => a.id);
    let approved = 0;
    let pending = 0;
    const byBrand = new Map();

    if (ids.length) {
      const conversions = await this.prisma.conversion.findMany({
        where: { clientAssignmentId: { in: ids } },
        select: {
          clientAssignmentId: true,
          status: true,
          clientCommission: true,
          approvedCommission: true,
          supplierCommission: true,
        },
      });

      const assignmentMap = new Map(assignmentRows.map((a) => [a.id, a]));

      for (const conv of conversions) {
        const a = assignmentMap.get(conv.clientAssignmentId);
        const brand = a?.canonicalCampaign?.merchant?.displayName || "Other";
        if (!byBrand.has(brand)) {
          byBrand.set(brand, {
            brand,
            confirmedCommission: 0,
            pendingConfirmation: 0,
          });
        }
        const bucket = byBrand.get(brand);
        const amt = clientCommissionAmount(conv);
        const status = String(conv.status || "").toUpperCase();
        if (status === "APPROVED" || status === "PAID") {
          approved += amt;
          bucket.confirmedCommission += amt;
        } else if (status !== "REJECTED") {
          pending += amt;
          bucket.pendingConfirmation += amt;
        }
      }
    }

    const withdrawals = await this.prisma.clientWithdrawal.findMany({
      where: { clientId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    const inProgress = withdrawals
      .filter((w) => ["REQUESTED", "PROCESSING"].includes(w.status))
      .reduce((s, w) => s + money(w.amount), 0);
    const paid = withdrawals
      .filter((w) => w.status === "PAID")
      .reduce((s, w) => s + money(w.amount), 0);
    const available = Math.max(0, money(approved) - inProgress - paid);

    const financeCmp = await this.financeConsumer.compareClientEarnings(clientId, {
      assignmentIds: ids,
      reportingCurrency: client.currency || null,
    });
    const display = this.financeConsumer.resolveDisplayCommission({
      legacyApproved: approved,
      legacyPending: pending,
      financeNet: financeCmp.finance.net,
    });
    if (this.financeConsumer.getMode() === FINANCE_CONSUMER_MODES.SHADOW) {
      if (financeCmp.comparison.status !== "MATCH") {
        await this.financeConsumer.recordShadowDiscrepancy({
          clientId,
          scope: "portal_payments",
          comparison: financeCmp.comparison,
        });
      }
    }

    const displayApproved =
      this.financeConsumer.getMode() === FINANCE_CONSUMER_MODES.FINANCE
        ? display.approvedCommission
        : approved;
    const displayPending =
      this.financeConsumer.getMode() === FINANCE_CONSUMER_MODES.FINANCE
        ? display.pendingCommission
        : pending;
    const displayAvailable = Math.max(0, money(displayApproved) - inProgress - paid);

    const bank = await this.prisma.clientBankAccount.findUnique({ where: { clientId } });

    return {
      currency: client.currency || null,
      kpis: {
        available: money(
          this.financeConsumer.getMode() === FINANCE_CONSUMER_MODES.FINANCE
            ? displayAvailable
            : available,
        ),
        pending: money(displayPending),
        inProgress: money(inProgress),
        paid: money(paid),
      },
      commissionSource: display.source,
      commissionAuthoritative: display.authoritative,
      bank: bank
        ? {
            accountHolder: bank.accountHolder,
            bankName: bank.bankName,
            accountLast4: bank.accountNumberLast4,
            ifscCode: bank.ifscCode,
            accountType: bank.accountType,
            status: bank.status,
          }
        : null,
      byBrand: [...byBrand.values()].map((b) => ({
        brand: b.brand,
        confirmedCommission: money(b.confirmedCommission),
        pendingConfirmation: money(b.pendingConfirmation),
      })),
      withdrawals: withdrawals.map((w) => ({
        id: w.id,
        reference: w.reference,
        date: w.createdAt.toISOString().slice(0, 10),
        amount: money(w.amount),
        currency: w.currency,
        status: w.status === "REQUESTED" ? "Requested" : w.status === "PROCESSING" ? "Processing" : w.status === "PAID" ? "Paid" : w.status,
      })),
    };
  }

  async saveBankDetails(clientId, body) {
    await this.assertClient(clientId);
    const holder = String(body.accountHolder || "").trim();
    const bankName = String(body.bankName || "").trim();
    const accountNumber = String(body.accountNumber || "").replace(/\s+/g, "");
    const ifsc = String(body.ifscCode || "")
      .trim()
      .toUpperCase();
    const accountType = String(body.accountType || "Current").trim() || "Current";

    if (!holder || !bankName || !accountNumber || !ifsc) {
      throw fail("All bank fields are required.", 400);
    }
    if (accountNumber.length < 6) throw fail("Account number looks invalid.", 400);
    if (ifsc.length < 4) throw fail("IFSC code looks invalid.", 400);

    const key = bankEncKey();
    if (!key) throw fail("Server encryption is not configured.", 500);

    const data = {
      accountHolder: holder,
      bankName,
      accountNumberLast4: accountNumber.slice(-4),
      accountNumberEnc: encryptSecret(accountNumber, key),
      ifscCode: ifsc,
      accountType,
      status: "VERIFIED",
    };

    const record = await this.prisma.clientBankAccount.upsert({
      where: { clientId },
      create: { clientId, ...data },
      update: data,
    });

    return {
      accountHolder: record.accountHolder,
      bankName: record.bankName,
      accountLast4: record.accountNumberLast4,
      ifscCode: record.ifscCode,
      accountType: record.accountType,
      status: record.status,
    };
  }

  async requestWithdrawal(clientId, { amount, requestedBy }) {
    await this.assertClient(clientId);
    const bank = await this.prisma.clientBankAccount.findUnique({ where: { clientId } });
    if (!bank) throw fail("Add bank details before requesting a withdrawal.", 400);

    const summary = await this.getPaymentsSummary(clientId);
    const value = money(amount);
    if (!value || value < 1000) throw fail("Minimum withdrawal is 1,000.", 400);
    if (value > summary.kpis.available) throw fail("Amount exceeds available balance.", 400);

    let reference = newWithdrawalRef();
    for (let i = 0; i < 5; i += 1) {
      const clash = await this.prisma.clientWithdrawal.findUnique({ where: { reference } });
      if (!clash) break;
      reference = newWithdrawalRef();
    }

    const row = await this.prisma.clientWithdrawal.create({
      data: {
        clientId,
        reference,
        amount: value,
        currency: summary.currency || undefined,
        status: "REQUESTED",
        requestedBy: requestedBy || null,
      },
    });

    try {
      await this.audit.record({
        aggregateType: "ClientWithdrawal",
        aggregateId: row.id,
        action: "withdrawal.request",
        after: {
          clientId,
          reference: row.reference,
          amount: String(value),
          status: "REQUESTED",
        },
      });
    } catch {
      // best-effort
    }

    return {
      id: row.id,
      reference: row.reference,
      date: row.createdAt.toISOString().slice(0, 10),
      amount: money(row.amount),
      status: "Requested",
    };
  }

  async listTeam(clientId) {
    await this.assertClient(clientId);
    const rows = await this.prisma.user.findMany({
      where: { clientId, role: "CLIENT" },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        email: true,
        name: true,
        isActive: true,
        createdAt: true,
      },
    });
    return rows.map((row, index) => ({
      id: row.id,
      name: row.name || row.email,
      email: row.email,
      role: index === 0 ? "Client Admin" : "Team Member",
      status: row.isActive ? "Active" : "Inactive",
      createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
    }));
  }

  async getSettings(clientId) {
    const client = await this.assertClient(clientId);
    const prefs =
      client.portalPreferences && typeof client.portalPreferences === "object"
        ? client.portalPreferences
        : {};
    const [team, bank, tax, apiKeys] = await Promise.all([
      this.listTeam(clientId),
      this.prisma.clientBankAccount.findUnique({ where: { clientId } }),
      this.prisma.clientTaxProfile.findUnique({ where: { clientId } }).catch(() => null),
      this.prisma.clientApiCredential
        .findMany({
          where: { clientId, revokedAt: null },
          orderBy: { createdAt: "desc" },
          take: 10,
          select: {
            id: true,
            name: true,
            environment: true,
            keyPrefix: true,
            lastUsedAt: true,
            createdAt: true,
          },
        })
        .catch(() => []),
    ]);

    const profile = prefs.profile && typeof prefs.profile === "object" ? prefs.profile : {};

    return {
      organisation: {
        name: client.name,
        legalName: client.legalName || profile.legalName || null,
        clientCode: client.slug ? `MBO-${String(client.slug).toUpperCase()}` : null,
        country: client.country,
        currency: client.currency,
        timezone: client.timezone || null,
        industry: client.industry || null,
        commercialModel: client.commercialModel,
        clientSharePercent:
          client.clientSharePercent != null ? Number(client.clientSharePercent) : null,
        status: client.status,
        deliveryMethod: client.deliveryMethod || null,
        primaryContactName: profile.primaryContactName || null,
        primaryContactEmail: profile.primaryContactEmail || null,
        financeContactEmail: profile.financeContactEmail || null,
        phone: profile.phone || null,
        registeredAddress: profile.registeredAddress || null,
        taxRegistrationId: profile.taxRegistrationId || tax?.notes || null,
      },
      billing: {
        billingMethod: profile.billingMethod || "Invoice Required",
        billingCurrency: client.currency || null,
        billingContact: profile.financeContactEmail || profile.billingContact || null,
        taxId: profile.taxRegistrationId || null,
        billingAddress: profile.billingAddress || profile.registeredAddress || null,
        taxCountry: tax?.taxCountry || client.country || null,
      },
      payment: {
        paymentMethod: "Bank Transfer",
        accountHolder: bank?.accountHolder || null,
        bankName: bank?.bankName || null,
        accountLast4: bank?.accountNumberLast4 || null,
        ifscCode: bank?.ifscCode || null,
        accountType: bank?.accountType || null,
        bankCountry: profile.bankCountry || client.country || null,
        status: bank?.status || "NOT_ADDED",
      },
      commercials: {
        settlementCurrency: client.currency || null,
        minimumWithdrawal: profile.minimumWithdrawal || "100.00",
        billingMethod: profile.billingMethod || "Invoice Required",
        settlementFrequency: client.paymentCycle || profile.settlementFrequency || "Monthly",
        campaignCommission: "Varies by campaign",
        accountStatus: client.status,
        commercialModel: client.commercialModel,
        clientSharePercent:
          client.clientSharePercent != null ? Number(client.clientSharePercent) : null,
        agreementStatus: client.agreementStatus || null,
        paymentTrigger: client.paymentTrigger || null,
      },
      api: {
        deliveryMethod: client.deliveryMethod || null,
        clientId: client.id,
        clientCode: client.slug ? `MBO-${String(client.slug).toUpperCase()}` : null,
        authentication: "API Key",
        apiStatus: apiKeys.length ? "ACTIVE" : "NOT_CONFIGURED",
        productionBaseUrl: "https://api.mbo-rewards.com/v1",
        sandboxBaseUrl: "https://sandbox-api.mbo-rewards.com/v1",
        keys: (apiKeys || []).map((k) => ({
          id: k.id,
          name: k.name,
          environment: k.environment || "PRODUCTION",
          keyPrefix: k.keyPrefix,
          lastUsedAt: k.lastUsedAt?.toISOString?.() ?? k.lastUsedAt,
          createdAt: k.createdAt?.toISOString?.() ?? k.createdAt,
        })),
        lastApiActivity: apiKeys?.[0]?.lastUsedAt?.toISOString?.() || null,
      },
      notifications: {
        campaignUpdates: prefs.campaignUpdates !== false,
        campaignExpiry: prefs.campaignExpiry !== false,
        statementReleased: prefs.statementReleased !== false,
        withdrawalUpdates: prefs.withdrawalUpdates !== false,
        paymentUpdates: prefs.paymentUpdates !== false,
        securityAlerts: prefs.securityAlerts !== false,
      },
      security: {
        twoFactorRequired: true,
        newLoginAlerts: prefs.newLoginAlerts !== false,
      },
      team,
    };
  }

  async updateSettings(clientId, body = {}) {
    const client = await this.assertClient(clientId);
    const data = {};
    const existing =
      client.portalPreferences && typeof client.portalPreferences === "object"
        ? { ...client.portalPreferences }
        : {};
    const profile =
      existing.profile && typeof existing.profile === "object" ? { ...existing.profile } : {};

    if (body.organisation?.name && String(body.organisation.name).trim()) {
      data.name = String(body.organisation.name).trim();
    }
    if (body.organisation?.legalName != null) {
      data.legalName = String(body.organisation.legalName).trim() || null;
    }
    if (body.organisation?.primaryContactName != null) {
      profile.primaryContactName = String(body.organisation.primaryContactName).trim() || null;
    }
    if (body.organisation?.primaryContactEmail != null) {
      profile.primaryContactEmail = String(body.organisation.primaryContactEmail).trim() || null;
    }
    if (body.organisation?.financeContactEmail != null) {
      profile.financeContactEmail = String(body.organisation.financeContactEmail).trim() || null;
    }
    if (body.organisation?.phone != null) {
      profile.phone = String(body.organisation.phone).trim() || null;
    }
    if (body.organisation?.registeredAddress != null) {
      profile.registeredAddress = String(body.organisation.registeredAddress).trim() || null;
    }
    if (body.organisation?.taxRegistrationId != null) {
      profile.taxRegistrationId = String(body.organisation.taxRegistrationId).trim() || null;
    }
    if (body.billing?.billingContact != null) {
      profile.billingContact = String(body.billing.billingContact).trim() || null;
      profile.financeContactEmail = profile.billingContact || profile.financeContactEmail;
    }
    if (body.billing?.billingAddress != null) {
      profile.billingAddress = String(body.billing.billingAddress).trim() || null;
    }
    if (body.billing?.taxId != null) {
      profile.taxRegistrationId = String(body.billing.taxId).trim() || null;
    }
    if (body.payment?.bankCountry != null) {
      profile.bankCountry = String(body.payment.bankCountry).trim() || null;
    }

    if (body.notifications) {
      const n = body.notifications;
      if (n.campaignUpdates != null) existing.campaignUpdates = n.campaignUpdates !== false;
      if (n.campaignExpiry != null) existing.campaignExpiry = n.campaignExpiry !== false;
      if (n.statementReleased != null) existing.statementReleased = n.statementReleased !== false;
      if (n.withdrawalUpdates != null) existing.withdrawalUpdates = n.withdrawalUpdates !== false;
      if (n.paymentUpdates != null) existing.paymentUpdates = n.paymentUpdates !== false;
      if (n.securityAlerts != null) existing.securityAlerts = n.securityAlerts !== false;
    }
    if (body.security?.newLoginAlerts != null) {
      existing.newLoginAlerts = body.security.newLoginAlerts !== false;
    }

    existing.profile = profile;
    data.portalPreferences = existing;

    const updated = await this.prisma.client.update({
      where: { id: clientId },
      data,
    });

    // Optional bank update when payment fields include a full account number
    if (body.payment?.accountNumber && body.payment?.accountHolder && body.payment?.bankName) {
      await this.saveBankDetails(clientId, {
        accountHolder: body.payment.accountHolder,
        bankName: body.payment.bankName,
        accountNumber: body.payment.accountNumber,
        ifscCode: body.payment.ifscCode || body.payment.swiftOrIfsc,
        accountType: body.payment.accountType || "Current",
      }).catch(() => null);
    }

    return this.getSettings(updated.id);
  }

  async getPayableStatementDetail(clientId, statementId) {
    await this.assertClient(clientId);
    const list = await this.listPayableStatements(clientId, { pageSize: 100 });
    const statement =
      list.statements.find((s) => s.id === statementId || s.statementId === statementId) || null;
    if (!statement) throw fail("Statement not found.", 404);
    return {
      statement,
      document: {
        title: "PAYABLE STATEMENT",
        clientName: (await this.assertClient(clientId)).name,
        ...statement,
        lineItems: [
          {
            description: `Commission for ${statement.periodLabel}`,
            amount: statement.amount,
            currency: statement.currency,
          },
        ],
        note: "Client-safe payable statement summary. Network commission and MBO margin are not included.",
      },
    };
  }

  async getWithdrawalRequestDetail(clientId, requestId) {
    await this.assertClient(clientId);
    const list = await this.listWithdrawalRequests(clientId, {});
    const request =
      list.requests.find((r) => r.id === requestId || r.requestId === requestId) || null;
    if (!request) throw fail("Withdrawal request not found.", 404);
    const timeline = [
      { at: request.requestDate, label: "Requested", status: "done" },
      {
        at: null,
        label: "Under review",
        status: ["UNDER REVIEW", "APPROVED", "PAID"].includes(request.status) ? "done" : "pending",
      },
      {
        at: null,
        label: "Approved for payout",
        status: ["APPROVED", "PAID"].includes(request.status) ? "done" : "pending",
      },
      {
        at: null,
        label: "Paid",
        status: request.status === "PAID" ? "done" : "pending",
      },
    ];
    return { request, timeline };
  }

  async listNotifications(clientId) {
    await this.assertClient(clientId);
    // Lightweight derived notifications from recent portal activity (no separate inbox table yet).
    const [statements, withdrawals] = await Promise.all([
      this.prisma.clientStatement.findMany({
        where: { clientId, status: "OPEN" },
        orderBy: { periodStart: "desc" },
        take: 3,
      }),
      this.prisma.clientWithdrawal.findMany({
        where: { clientId },
        orderBy: { createdAt: "desc" },
        take: 3,
      }),
    ]);
    const items = [];
    for (const s of statements) {
      items.push({
        id: `stmt-${s.id}`,
        type: "STATEMENT",
        title: "Payable statement available",
        body: `Period ${s.periodStart.toISOString().slice(0, 7)} is ready for withdrawal.`,
        createdAt: s.createdAt?.toISOString?.() || new Date().toISOString(),
        read: false,
      });
    }
    for (const w of withdrawals) {
      items.push({
        id: `wd-${w.id}`,
        type: "WITHDRAWAL",
        title: `Withdrawal ${w.status}`,
        body: `${w.reference || w.id} · ${money(w.amount)} ${w.currency || ""}`.trim(),
        createdAt: w.createdAt?.toISOString?.() || new Date().toISOString(),
        read: false,
      });
    }
    return { items: items.slice(0, 8), unread: items.length };
  }

  async createSupportRequest(clientId, { type, category, subject, body, createdBy }) {
    await this.assertClient(clientId);
    const text = String(body || "").trim();
    if (!text) throw fail("Description is required.", 400);

    const row = await this.prisma.clientSupportRequest.create({
      data: {
        clientId,
        type: type === "CAMPAIGN_REQUEST" ? "CAMPAIGN_REQUEST" : "SUPPORT_TICKET",
        category: category || null,
        subject: subject || null,
        body: text,
        createdBy: createdBy || null,
      },
    });

    if (row.type === "CAMPAIGN_REQUEST") {
      await this.prisma.clientBrandRequest.create({
        data: {
          clientId,
          requestedBrandName: subject || text.slice(0, 120),
          requestedBy: createdBy || null,
          notes: text,
          status: "REQUESTED",
        },
      });
    }

    return {
      id: row.id,
      type: row.type,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Payable statements — list ClientStatement rows for this client.
   * Derives "available" amount per statement from invoices and withdrawals.
   */
  async listPayableStatements(clientId, query = {}) {
    await this.assertClient(clientId);
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));

    const [rows, total] = await Promise.all([
      this.prisma.clientStatement.findMany({
        where: { clientId },
        orderBy: { periodStart: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          invoices: {
            select: {
              id: true,
              invoiceNumber: true,
              total: true,
              subtotal: true,
              status: true,
              issuedAt: true,
            },
          },
        },
      }),
      this.prisma.clientStatement.count({ where: { clientId } }),
    ]);

    const withdrawals = await this.prisma.clientWithdrawal.findMany({
      where: { clientId },
      select: { id: true, reference: true, amount: true, currency: true, status: true, createdAt: true },
    });

    const statements = rows.map((stmt) => {
      const invoice = stmt.invoices?.[0] || null;
      const amount = money(stmt.closingBalance);
      const statementId = `PS-${String(clientId).slice(0, 4).toUpperCase()}-${stmt.periodStart.toISOString().slice(0, 7).replace("-", "")}-${String(stmt.id).slice(-3)}`;
      // Map statement status to client-friendly label
      const statusMap = { OPEN: "AVAILABLE", CLOSED: "PAID", SUPERSEDED: "CANCELLED" };
      const displayStatus = statusMap[stmt.status] || stmt.status;

      return {
        id: stmt.id,
        statementId,
        period: stmt.periodStart.toISOString().slice(0, 7),
        periodLabel: stmt.periodStart.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }),
        periodStart: stmt.periodStart.toISOString().slice(0, 10),
        periodEnd: stmt.periodEnd.toISOString().slice(0, 10),
        currency: stmt.currency,
        amount,
        openingBalance: money(stmt.openingBalance),
        closingBalance: money(stmt.closingBalance),
        status: displayStatus,
        invoiceNumber: invoice?.invoiceNumber || null,
        invoiceAmount: invoice ? money(invoice.total) : null,
        createdAt: stmt.createdAt.toISOString(),
      };
    });

    // Summary KPIs from withdrawal and statement data
    const totalAvailable = statements
      .filter((s) => s.status === "AVAILABLE")
      .reduce((sum, s) => sum + s.amount, 0);
    const totalPaid = statements
      .filter((s) => s.status === "PAID")
      .reduce((sum, s) => sum + s.amount, 0);

    return {
      statements,
      pagination: { page, pageSize, total },
      kpis: {
        totalStatements: total,
        availableAmount: money(totalAvailable),
        paidAmount: money(totalPaid),
      },
    };
  }

  /**
   * Withdrawal requests — list with rich detail matching the screenshots.
   * Each withdrawal is linked to a payable statement where one exists.
   */
  async listWithdrawalRequests(clientId, query = {}) {
    await this.assertClient(clientId);
    const statusFilter = query.status && query.status !== "all" ? String(query.status).toUpperCase() : null;

    const where = { clientId };
    if (statusFilter) where.status = statusFilter;

    const [withdrawals, total] = await Promise.all([
      this.prisma.clientWithdrawal.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      this.prisma.clientWithdrawal.count({ where }),
    ]);

    // Summary KPIs
    const allWithdrawals = await this.prisma.clientWithdrawal.findMany({
      where: { clientId },
      select: { amount: true, status: true, createdAt: true },
    });

    const available = await this.getPaymentsSummary(clientId);
    const underReview = allWithdrawals
      .filter((w) => w.status === "REQUESTED")
      .reduce((s, w) => s + money(w.amount), 0);
    const approved = allWithdrawals
      .filter((w) => w.status === "PROCESSING")
      .reduce((s, w) => s + money(w.amount), 0);
    const now = new Date();
    const paidThisMonth = allWithdrawals
      .filter((w) => {
        if (w.status !== "PAID") return false;
        const d = new Date(w.createdAt);
        return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
      })
      .reduce((s, w) => s + money(w.amount), 0);

    // Get latest statements for linking
    const statements = await this.prisma.clientStatement.findMany({
      where: { clientId },
      orderBy: { periodStart: "desc" },
      take: 20,
      include: { invoices: { select: { invoiceNumber: true }, take: 1 } },
    });

    const latestStatement = statements[0] || null;

    const rows = withdrawals.map((w, i) => {
      // Try to link to a statement — use most recent statement for most recent withdrawal
      const stmt = statements[i] || latestStatement;
      const stmtId = stmt
        ? `PS-${String(clientId).slice(0, 4).toUpperCase()}-${stmt.periodStart.toISOString().slice(0, 7).replace("-", "")}-${String(stmt.id).slice(-3)}`
        : null;
      const invoiceNumber = stmt?.invoices?.[0]?.invoiceNumber || null;
      const reqId = `REQ-${String(w.id).slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, "0")}`;
      const settlementPeriod = stmt
        ? stmt.periodStart.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
        : new Date(w.createdAt).toLocaleString("en-US", { month: "short", year: "numeric" });

      const statusMap = {
        REQUESTED: "UNDER REVIEW",
        PROCESSING: "APPROVED",
        PAID: "PAID",
        REJECTED: "REJECTED",
        CANCELLED: "CANCELLED",
      };

      return {
        id: w.id,
        requestId: reqId,
        requestDate: w.createdAt.toISOString().slice(0, 10),
        settlementPeriod,
        statementId: stmtId,
        requestedAmount: money(w.amount),
        currency: w.currency,
        invoiceNumber,
        status: statusMap[w.status] || w.status,
        rawStatus: w.status,
        notes: w.notes || null,
      };
    });

    return {
      requests: rows,
      total,
      kpis: {
        availableForWithdrawal: available.kpis.available,
        underReview: money(underReview),
        approved: money(approved),
        paidThisMonth: money(paidThisMonth),
        currency: available.currency,
      },
    };
  }

  /**
   * New dashboard summary — matches the screenshot layout exactly.
   * Returns 6 KPI cards, performance summary by brand, withdrawal balance,
   * recent statements, recent payments, and available campaigns preview.
   */
  async getDashboardSummary(clientId) {
    const client = await this.assertClient(clientId);

    const [campaignsPayload, performance, paymentsSummary, statements, recentWithdrawals] =
      await Promise.all([
        this.partnerCampaigns.listCampaigns(clientId, { page: 1, pageSize: 200 }),
        this.getPerformance(clientId, { pageSize: 200 }),
        this.getPaymentsSummary(clientId),
        this.prisma.clientStatement.findMany({
          where: { clientId },
          orderBy: { periodStart: "desc" },
          take: 3,
          include: { invoices: { select: { invoiceNumber: true }, take: 1 } },
        }),
        this.prisma.clientWithdrawal.findMany({
          where: { clientId, status: "PAID" },
          orderBy: { createdAt: "desc" },
          take: 1,
        }),
      ]);

    const campaigns = campaignsPayload?.campaigns || [];
    const activeCampaigns = campaigns.filter(
      (c) =>
        String(c.assignmentStatus || "").toUpperCase() === "CLIENT_VISIBLE" ||
        c.displayStatus === "Live",
    ).length;

    const perfRows = performance?.rows || [];
    const perfKpis = performance?.kpis || {};

    // Aggregate by brand for the performance summary table
    const brandMap = new Map();
    for (const row of perfRows) {
      // Performance DTO uses brandName (string); never use row.brand which may be an object
      const brand = String(row.brandName || row.merchantName || row.brand?.name || "Other");
      const campaign = String(row.campaignName || row.campaign || brand);
      const key = row.merchantId || brand;
      if (!brandMap.has(key)) {
        brandMap.set(key, {
          brand,
          campaign,
          orders: 0,
          confirmedOrders: 0,
          confirmedOrderValue: 0,
          commission: 0,
        });
      }
      const b = brandMap.get(key);
      b.orders += Number(row.orders || row.grossOrders || 0);
      b.confirmedOrders += Number(row.confirmedOrders || row.approvedOrders || 0);
      b.confirmedOrderValue += Number(row.confirmedOrderValue || row.netOrderValue || 0);
      b.commission += Number(row.approvedCommission || row.clientCommission || 0);
    }

    const performanceSummary = [...brandMap.values()].slice(0, 10).map((b) => ({
      brand: b.brand,
      campaign: b.campaign,
      orders: Math.round(b.orders),
      confirmedOrders: Math.round(b.confirmedOrders),
      confirmedOrderValue: money(b.confirmedOrderValue),
      commission: money(b.commission),
    }));

    // Recent payable statements
    const recentStatements = statements.map((stmt) => {
      const stmtId = `PS-${String(clientId).slice(0, 4).toUpperCase()}-${stmt.periodStart.toISOString().slice(0, 7).replace("-", "")}-${String(stmt.id).slice(-3)}`;
      const periodLabel = stmt.periodStart.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
      const statusMap = { OPEN: "AVAILABLE", CLOSED: "PAID", SUPERSEDED: "CANCELLED" };
      return {
        statementId: stmtId,
        period: periodLabel,
        amount: money(stmt.closingBalance),
        currency: stmt.currency,
        status: statusMap[stmt.status] || stmt.status,
        invoiceNumber: stmt.invoices?.[0]?.invoiceNumber || null,
      };
    });

    // Most recent payment
    const latestWithdrawal = recentWithdrawals[0] || null;
    const paymentRef = latestWithdrawal
      ? `PAY-${String(latestWithdrawal.id).slice(-6).toUpperCase().replace(/[^A-Z0-9]/g, "0")}`
      : null;

    // Available campaigns preview (first 3 live)
    // NOTE: c.brand is an object {id,name,logoUrl,websiteUrl} — use c.brandName for the string
    const availableCampaigns = campaigns
      .filter((c) => c.displayStatus === "Live" || String(c.assignmentStatus || "").toUpperCase() === "CLIENT_VISIBLE")
      .slice(0, 3)
      .map((c) => ({
        brand: String(c.brandName || c.brand?.name || c.brand || "Brand"),
        campaign: String(c.campaignName || c.name || "Campaign"),
        type: String(c.campaignType || c.channel || "Affiliate Link"),
        commission: String(c.commissionLabel || (c.clientSharePercent ? `${c.clientSharePercent}% commission` : "Commission")),
        status: String(c.displayStatus || "LIVE"),
        isNew: Boolean(c.isNew),
      }));

    const currency = client.currency || paymentsSummary.currency || "USD";

    return {
      kpis: {
        activeCampaigns,
        orders: Math.round(Number(perfKpis.grossOrders || 0)),
        confirmedOrders: Math.round(Number(perfKpis.confirmedOrders || perfKpis.approvedOrders || 0)),
        confirmedOrderValue: money(perfKpis.netOrderValue || 0),
        confirmedCommission: money(paymentsSummary.kpis.approved || 0),
        availableToWithdraw: money(paymentsSummary.kpis.available || 0),
        currency,
        period: new Date().toLocaleString("en-US", { month: "short", year: "numeric" }),
      },
      performanceSummary,
      withdrawalBalance: {
        available: money(paymentsSummary.kpis.available || 0),
        currency,
        pendingRequest: money(paymentsSummary.kpis.inProgress || 0),
        approvedForPayout: money(
          (paymentsSummary.withdrawals || [])
            .filter((w) => w.status === "Processing")
            .reduce((s, w) => s + money(w.amount), 0),
        ),
        paidThisMonth: money(paymentsSummary.kpis.paid || 0),
      },
      recentStatements,
      recentPayment: latestWithdrawal
        ? {
            paymentId: paymentRef,
            amount: money(latestWithdrawal.amount),
            currency: latestWithdrawal.currency || currency,
            date: latestWithdrawal.createdAt.toISOString().slice(0, 10),
            status: "PAID",
            reference: latestWithdrawal.reference,
          }
        : null,
      availableCampaigns,
      client: {
        name: client.name,
        currency,
      },
    };
  }

  async getApiDocs(clientId) {
    await this.assertClient(clientId);
    return {
      // Host-absolute paths for documentation only — do NOT concatenate onto a base that already ends in /api.
      canonicalBaseUrl: "/api/v1/client",
      baseUrl: "/api/v1/client",
      compatibilityAliases: {
        partner: "/api/partner/v1",
        portal: "/api/portal/v1",
      },
      auth: {
        primary: "Authorization: Bearer mbo_live_…",
        alternative: "X-Api-Key: mbo_live_… (same key) or client portal JWT for /portal/v1/*",
        note: "The API key secret is shown only once at creation or rotate. It is stored as a hash and cannot be recovered.",
      },
      endpoints: [
        {
          method: "GET",
          path: "/campaigns",
          fullPath: "/api/v1/client/campaigns",
          description:
            "Canonical client campaign catalog (v15 06C). Published assignments only for the authenticated client.",
          query: ["page", "pageSize", "search", "brand", "category", "country", "status"],
          alsoAt: ["/api/partner/v1/campaigns", "/api/portal/v1/campaigns"],
        },
        {
          method: "GET",
          path: "/campaigns/:id",
          fullPath: "/api/v1/client/campaigns/:id",
          description:
            "Fetch one campaign by assignment id or canonical campaign id (tenant-scoped).",
        },
        {
          method: "GET",
          path: "/orders",
          fullPath: "/api/v1/client/orders",
          alsoAt: ["/api/partner/v1/orders", "/api/portal/v1/orders"],
          description: "Client-safe order report (v15 09C). No supplier internals or MBO margin.",
        },
        {
          method: "GET",
          path: "/payments",
          fullPath: "/api/v1/client/payments",
          alsoAt: ["/api/partner/v1/payment-status", "/api/portal/v1/payment-status"],
          description:
            "Payment-status / payable commission report by billing month (v15 09C/05A). Not withdrawals.",
        },
      ],
      notes: [
        "Canonical contract path is /api/v1/client/* (workbook 06C). Partner and portal paths are compatibility aliases to the same service.",
        "Client identity is derived from the API key — never pass clientId in the URL or body.",
        "Only published, allotted, client-safe fields are returned (brand, MBO tracking URL, offer, coupon, client commission share).",
        "Public campaign identifier: assignmentId (stable). campaignId is the canonical campaign id.",
        "Withdrawals and bank details remain on GET/PUT /api/portal/v1/payments and related portal routes.",
        "Monetary fields prefer FinancialTransaction when present; otherwise order/conversion snapshots.",
      ],
    };
  }
}
