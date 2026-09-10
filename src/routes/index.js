import { Router } from "express";
// TEMPORARY — preview-only, read-only staff user metadata audit (remove with the route below).
import {
  PREVIEW_ADMIN_USER_AUDIT_ROUTE,
  adminUserAuditPreviewHandler,
} from "./internal/adminUserAuditPreview.js";
import { PERMISSIONS } from "../auth/permissions.js";
import { getEntities, getEntitySummaryHandler } from "../controllers/entities.controller.js";
import {
  getImportedRecordHandler,
  importedRecordsFacetsHandler,
  importedRecordsSummaryHandler,
  listImportedRecordsHandler,
  reprocessImportedRecordsHandler,
  importedRecordsColumnsHandler,
} from "../controllers/importedRecords.controller.js";
import { getFields } from "../controllers/fields.controller.js";
import {
  getMappingRegistryRuleHandler,
  listMappingRegistryHandler,
  syncMappingRegistryHandler,
} from "../controllers/mappingRegistry.controller.js";
import {
  getSyncStatusHandler,
  triggerIncrementalSync,
  triggerSyncAll,
  triggerSyncPlatform,
} from "../controllers/sync.controller.js";
import { getConnections, oauthCallback, oauthConnect } from "../controllers/oauth.controller.js";
import {
  connectMarketplaceAccount,
  disconnectMarketplaceAccount,
} from "../controllers/marketplaceAccounts.controller.js";
import {
  createAdminCoupon,
  getAdminCoupon,
  getAdminCouponCommercial,
  listAdminCoupons,
  patchAdminCoupon,
  removeAdminCoupon,
} from "../controllers/couponCms.controller.js";
import { listMapperErrorsHandler, retryMapperErrorHandler } from "../controllers/mapperErrors.controller.js";
import { runPromotionHandler, retryPromotionHandler } from "../controllers/promotion.controller.js";
import { listSuppliersHandler, getSupplierHandler } from "../controllers/suppliers.controller.js";
import { networkOpsDashboardHandler } from "../controllers/networkOpsDashboard.controller.js";
import {
  getNetworkBrandWorkspaceHandler,
  getSupplierCampaignHandler,
  listNetworkBrandsHandler,
  listSupplierCampaignsHandler,
  promoteSupplierCampaignsHandler,
} from "../controllers/supplierCampaigns.controller.js";
import { masterCatalogSummaryHandler } from "../controllers/masterCatalogDashboard.controller.js";
import { clientOpsGuideHandler } from "../controllers/clientOpsGuide.controller.js";
import { aiIntegrationGuideHandler } from "../controllers/aiIntegrationGuide.controller.js";
import { globalSearchHandler } from "../controllers/globalSearch.controller.js";
import { listSupplierCouponsHandler } from "../controllers/supplierCoupons.controller.js";
import {
  getCouponColumns,
  patchCouponColumn,
  postCouponColumn,
  putCouponColumns,
  removeCouponColumn,
  resetCouponColumnsHandler,
} from "../controllers/couponColumns.controller.js";
import {
  loginHandler,
  logoutHandler,
  meHandler,
  registerHandler,
  sendOtpHandler,
  verifyOtpHandler,
} from "../controllers/auth.controller.js";
import {
  createUserHandler,
  listAccessLogsHandler,
  listUsersHandler,
  updateUserHandler,
} from "../controllers/users.controller.js";
import {
  createMerchantHandler,
  getMerchantHandler,
  listMerchantsHandler,
  mergeMerchantHandler,
  updateMerchantHandler,
} from "../controllers/merchants.controller.js";
import { runMerchantMatchingHandler } from "../controllers/merchantMatching.controller.js";
import {
  listMerchantReviewsHandler,
  getMerchantReviewHandler,
  updateMerchantReviewHandler,
} from "../controllers/merchantReview.controller.js";
import {
  attachCatalogSourceHandler,
  createCatalogHandler,
  getCatalogHandler,
  listCatalogHandler,
  promoteCatalogSourceHandler,
  updateCatalogHandler,
  updateCatalogSourceHandler,
} from "../controllers/catalog.controller.js";
import {
  createAssignmentHandler,
  createBrandRequestHandler,
  createClientHandler,
  deleteClientHandler,
  getClientHandler,
  listAssignmentsHandler,
  listBrandRequestsHandler,
  listClientsHandler,
  updateAssignmentHandler,
  updateBrandRequestHandler,
  updateClientHandler,
} from "../controllers/clients.controller.js";
import {
  createApiCredentialHandler,
  createPortalUserHandler,
  listApiCredentialsHandler,
  listPortalUsersHandler,
  revokeApiCredentialHandler,
} from "../controllers/clientCredentials.controller.js";
import {
  partnerGetCampaignHandler,
  partnerListCampaignsHandler,
} from "../controllers/partnerCampaigns.controller.js";
import {
  portalApiDocsHandler,
  portalListApiKeysHandler,
  portalMeHandler,
  portalOverviewHandler,
  portalPaymentsHandler,
  portalPerformanceHandler,
  portalRotateApiKeyHandler,
  portalSaveBankHandler,
  portalSettingsGetHandler,
  portalSettingsPatchHandler,
  portalSupportHandler,
  portalTeamHandler,
  portalWithdrawHandler,
  portalListPayableStatementsHandler,
  portalListWithdrawalRequestsHandler,
  portalGetPayableStatementHandler,
  portalGetWithdrawalRequestHandler,
  portalNotificationsHandler,
  portalDashboardSummaryHandler,
} from "../controllers/portal.controller.js";
import {
  activateOnboardingClientHandler,
  allotCampaignsHandler,
  getInviteHandler,
  getOnboardingStateHandler,
  inviteAdministratorHandler,
  provisionClientHandler,
  setCommercialModelHandler,
  setPasswordHandler,
} from "../controllers/clientOnboarding.controller.js";
import {
  getClientAllocationCampaignHandler,
  listClientAllocationCampaignsHandler,
} from "../controllers/clientAllocation.controller.js";
import {
  createCommissionRuleHandler,
  createCouponAssignmentHandler,
  createTrackingLinkHandler,
  getTrackingLinkDefaultsHandler,
  listCommissionRulesHandler,
  listCouponAssignmentsHandler,
  listTrackingLinksHandler,
  updateCommissionRuleHandler,
  updateCouponAssignmentHandler,
  updateTrackingLinkHandler,
} from "../controllers/commercial.controller.js";
import {
  ingestConversionHandler,
  listCampaignReportsHandler,
  listClicksHandler,
  listClientReportsHandler,
  listConversionsHandler,
  listDailyReportsHandler,
  listMerchantReportsHandler,
  listSourceReportsHandler,
  rebuildAggregationHandler,
  recordClickHandler,
  runAggregationHandler,
} from "../controllers/reporting.controller.js";
import {
  aggregationStatusHandler,
  databaseStatsHandler,
  deadLetterHandler,
  dispatchOutboxHandler,
  failedJobsHandler,
  matchingQueueHandler,
  promotionStatusHandler,
  queueStatusHandler,
  storageUsageHandler,
  systemMetricsHandler,
  workerStatusHandler,
} from "../platform/ops/ops.controller.js";
import {
  listExceptionsHandler,
  getExceptionHandler,
  acknowledgeExceptionHandler,
  assignExceptionHandler,
  resolveExceptionHandler,
  reopenExceptionHandler,
  retryExceptionHandler,
  listMappingReviewHandler,
  listRawPayloadsHandler,
  getRawPayloadHandler,
  replayRawPayloadHandler,
  reprocessHandler,
  listSyncRunsHandler,
  getSyncRunHandler,
  financeDashboardHandler,
  reconcileTransactionHandler,
  reconcileConversionHandler,
  reconcileClientHandler,
  reconcileSupplierHandler,
  portalCutoverReadinessHandler,
  dailyReportCutoverReadinessHandler,
  historicalFinanceCoverageHandler,
  listProductsHandler,
  getProductHandler,
  syncProductFeedsHandler,
  dataQualityHandler,
  assignmentCoverageHandler,
  supplierHealthHandler,
  jobHealthHandler,
  systemOpsHealthHandler,
} from "../controllers/opsWaveG.controller.js";
import {
  listProductFeedsHandler,
  ingestProductFeedHandler,
  assignClientProductHandler,
} from "../controllers/productFeed.controller.js";
import {
  adminListCampaignsHandler,
  adminGetCampaignHandler,
  adminListPerformanceHandler,
  adminListOrdersHandler,
  adminListClientOverviewHandler,
  adminListClientPerformanceHandler,
  adminListClientConfirmedOrdersHandler,
  adminReportingOverviewHandler,
  adminListProductFeedsHandler,
  adminCommissionVocabularyHandler,
  adminListPaymentStatusHandler,
} from "../controllers/adminContract.controller.js";
import {
  adminListNetworkBillingHandler,
  adminListNetworkPaymentsReceivedHandler,
  adminListMboReceiptsHandler,
} from "../controllers/adminNetworkFinance.controller.js";
import {
  adminListPayableOrdersHandler,
  adminListWithdrawalInvoiceRequestsHandler,
  adminListPayoutsHandler,
} from "../controllers/adminClientSettlements.controller.js";
import {
  boostinyListPaymentMappingsHandler,
  boostinyUpsertPaymentMappingHandler,
  boostinyListPartnerSettlementsHandler,
  boostinyUploadPartnerPaymentHandler,
} from "../controllers/boostinyPartnerPayment.controller.js";
import { adminTransitionOrderItemValidationHandler } from "../controllers/itemValidation.controller.js";
import {
  certifyMappingHandler,
  revokeMappingHandler,
  approveCatalogHandler,
  couponPoolHandler,
  reviewCouponAlertHandler,
  patchCouponInventoryHandler,
  networkReconHandler,
  rebuildNetworkReconHandler,
  mappingRulesHandler,
  supplierCommissionRulesHandler,
  createTestSupplierCommissionRuleHandler,
  networkTrackingLinksHandler,
} from "../controllers/networkPortal.controller.js";
import {
  clientListOrdersHandler,
  clientListConfirmedOrdersHandler,
  clientListPaymentsHandler,
  clientListCampaignsAliasHandler,
  clientGetCampaignAliasHandler,
  clientPerformanceAliasHandler,
  clientGetAccountHandler,
  clientPerformanceSummaryHandler,
  clientPerformanceCampaignsHandler,
  clientPerformanceAffiliateLinksHandler,
  clientPerformanceCouponsHandler,
  clientPerformanceOrdersHandler,
  clientListStatementsHandler,
  clientGetStatementHandler,
  clientListWithdrawalsHandler,
  clientCreateWithdrawalHandler,
  clientListPayoutsHandler,
} from "../controllers/clientReporting.controller.js";
import { clientListProductsHandler } from "../controllers/clientProducts.controller.js";
import { authRateLimiter } from "../platform/security/index.js";
import {
  auditAction,
  auditPartnerAccess,
  authenticate,
  authenticatePartner,
  requireDeliveryChannel,
  requireApiEndpoint,
  requireEntityTypeAccess,
  requirePermission,
} from "../middleware/auth.js";

const router = Router();

router.get("/health", (_req, res) => res.json({ ok: true }));

// TEMPORARY — Preview-only, READ-ONLY staff user metadata audit. Remove this
// route and src/routes/internal/adminUserAuditPreview.js once the staff-account
// evidence has been captured. It 404s outside VERCEL_ENV=preview, fails closed
// without ADMIN_USER_AUDIT_TOKEN, and answers 401/403 for a missing/wrong
// x-audit-token header. It never reaches Prisma unless every gate passes and
// can only read id/email/name/role/isActive/createdAt of non-CLIENT users.
router.post(PREVIEW_ADMIN_USER_AUDIT_ROUTE, adminUserAuditPreviewHandler);

router.post("/auth/send-otp", authRateLimiter, sendOtpHandler);
router.post("/auth/verify-otp", authRateLimiter, verifyOtpHandler);
router.post("/auth/register", authRateLimiter, registerHandler);
router.post("/auth/login", authRateLimiter, loginHandler);
router.get("/auth/me", authenticate, meHandler);
router.post("/auth/logout", authenticate, logoutHandler);
router.get("/auth/invite/:token", authRateLimiter, getInviteHandler);
router.post("/auth/set-password", authRateLimiter, setPasswordHandler);

router.get("/users", authenticate, requirePermission(PERMISSIONS.USERS_MANAGE), listUsersHandler);
router.post(
  "/users",
  authenticate,
  requirePermission(PERMISSIONS.USERS_MANAGE),
  auditAction("users.create", "users"),
  createUserHandler,
);
router.patch(
  "/users/:id",
  authenticate,
  requirePermission(PERMISSIONS.USERS_MANAGE),
  auditAction("users.update", (req) => `users:${req.params.id}`),
  updateUserHandler,
);
router.get(
  "/logs/access",
  authenticate,
  requirePermission(PERMISSIONS.LOGS_READ),
  listAccessLogsHandler,
);

router.get(
  "/sync/status",
  authenticate,
  requirePermission(PERMISSIONS.SYSTEM_READ),
  getSyncStatusHandler,
);
router.post(
  "/sync/all",
  authenticate,
  requirePermission(PERMISSIONS.SYNC_TRIGGER),
  auditAction("sync.all", "sync"),
  triggerSyncAll,
);
router.post(
  "/sync/incremental",
  authenticate,
  requirePermission(PERMISSIONS.SYNC_TRIGGER),
  auditAction("sync.incremental", "sync"),
  triggerIncrementalSync,
);
router.post(
  "/sync/:platform/:accountLabel",
  authenticate,
  requirePermission(PERMISSIONS.SYNC_TRIGGER),
  auditAction("sync.platform", (req) => `sync:${req.params.platform}`),
  triggerSyncPlatform,
);
router.post(
  "/sync/:platform",
  authenticate,
  requirePermission(PERMISSIONS.SYNC_TRIGGER),
  auditAction("sync.platform", (req) => `sync:${req.params.platform}`),
  triggerSyncPlatform,
);

router.get("/auth/connect/:platform", oauthConnect);
router.get("/auth/callback/marketplace/:platform", oauthCallback);

router.get(
  "/marketplace/accounts",
  authenticate,
  requirePermission(PERMISSIONS.INTEGRATIONS_READ),
  getConnections,
);
router.post(
  "/marketplace/accounts/:platform/connect",
  authenticate,
  requirePermission(PERMISSIONS.INTEGRATIONS_MANAGE),
  auditAction("integrations.connect", (req) => `integrations:${req.params.platform}`),
  connectMarketplaceAccount,
);
router.delete(
  "/marketplace/accounts/:platform/:accountLabel",
  authenticate,
  requirePermission(PERMISSIONS.INTEGRATIONS_MANAGE),
  auditAction("integrations.disconnect", (req) => `integrations:${req.params.platform}`),
  disconnectMarketplaceAccount,
);

router.get(
  "/entities",
  authenticate,
  requireEntityTypeAccess,
  auditAction("entities.read", (req) => `entities:${req.query.type || "all"}`),
  getEntities,
);
router.get(
  "/entities/summary",
  authenticate,
  requireEntityTypeAccess,
  getEntitySummaryHandler,
);

router.get(
  "/ops/imported-records",
  authenticate,
  requirePermission(PERMISSIONS.CAMPAIGNS_READ),
  auditAction("imported_records.read", "imported-records"),
  listImportedRecordsHandler,
);
router.get(
  "/ops/imported-records/summary",
  authenticate,
  requirePermission(PERMISSIONS.CAMPAIGNS_READ),
  importedRecordsSummaryHandler,
);
router.get(
  "/ops/imported-records/facets",
  authenticate,
  requirePermission(PERMISSIONS.CAMPAIGNS_READ),
  importedRecordsFacetsHandler,
);
router.get(
  "/ops/imported-records/columns",
  authenticate,
  requirePermission(PERMISSIONS.CAMPAIGNS_READ),
  importedRecordsColumnsHandler,
);
router.get(
  "/ops/imported-records/:id",
  authenticate,
  requirePermission(PERMISSIONS.CAMPAIGNS_READ),
  getImportedRecordHandler,
);
router.post(
  "/ops/imported-records/reprocess",
  authenticate,
  requirePermission(PERMISSIONS.SYNC_TRIGGER),
  auditAction("imported_records.reprocess", "imported-records"),
  reprocessImportedRecordsHandler,
);

router.get(
  "/fields",
  authenticate,
  requireEntityTypeAccess,
  getFields,
);

router.get("/coupons/columns", authenticate, requirePermission(PERMISSIONS.COUPONS_READ), getCouponColumns);
router.get(
  "/admin/coupons/columns",
  authenticate,
  requirePermission(PERMISSIONS.COUPONS_READ),
  getCouponColumns,
);
router.post(
  "/admin/coupons/columns",
  authenticate,
  requirePermission(PERMISSIONS.COUPON_COLUMNS_MANAGE),
  postCouponColumn,
);
router.put(
  "/admin/coupons/columns",
  authenticate,
  requirePermission(PERMISSIONS.COUPON_COLUMNS_MANAGE),
  putCouponColumns,
);
router.post(
  "/admin/coupons/columns/reset",
  authenticate,
  requirePermission(PERMISSIONS.COUPON_COLUMNS_MANAGE),
  resetCouponColumnsHandler,
);
router.patch(
  "/admin/coupons/columns/:key",
  authenticate,
  requirePermission(PERMISSIONS.COUPON_COLUMNS_MANAGE),
  patchCouponColumn,
);
router.delete(
  "/admin/coupons/columns/:key",
  authenticate,
  requirePermission(PERMISSIONS.COUPON_COLUMNS_MANAGE),
  removeCouponColumn,
);

router.get(
  "/admin/coupons",
  authenticate,
  requirePermission(PERMISSIONS.COUPONS_READ),
  listAdminCoupons,
);
/** CouponCodeMaster pool — mounted under canonical /admin/coupons (not /network-ops). */
router.get(
  "/admin/coupons/pool",
  authenticate,
  requirePermission(PERMISSIONS.COUPONS_READ),
  couponPoolHandler,
);
router.post(
  "/admin/coupons/pool/:id/review-alert",
  authenticate,
  requirePermission(PERMISSIONS.COUPONS_WRITE),
  auditAction("network.coupon.review_alert", "CouponCodeMaster"),
  reviewCouponAlertHandler,
);
router.patch(
  "/admin/coupons/pool/:id",
  authenticate,
  requirePermission(PERMISSIONS.COUPONS_WRITE),
  auditAction("network.coupon.inventory", "CouponCodeMaster"),
  patchCouponInventoryHandler,
);
router.get(
  "/admin/coupons/:id",
  authenticate,
  requirePermission(PERMISSIONS.COUPONS_READ),
  getAdminCoupon,
);
router.get(
  "/admin/coupons/:id/commercial",
  authenticate,
  requirePermission(PERMISSIONS.COUPONS_READ),
  getAdminCouponCommercial,
);
router.post(
  "/admin/coupons",
  authenticate,
  requirePermission(PERMISSIONS.COUPONS_WRITE),
  createAdminCoupon,
);
router.patch(
  "/admin/coupons/:id",
  authenticate,
  requirePermission(PERMISSIONS.COUPONS_WRITE),
  patchAdminCoupon,
);
router.delete(
  "/admin/coupons/:id",
  authenticate,
  requirePermission(PERMISSIONS.COUPONS_WRITE),
  removeAdminCoupon,
);

router.get(
  "/suppliers",
  authenticate,
  requirePermission(PERMISSIONS.CAMPAIGNS_READ),
  listSuppliersHandler,
);
router.get(
  "/suppliers/:key",
  authenticate,
  requirePermission(PERMISSIONS.CAMPAIGNS_READ),
  getSupplierHandler,
);

router.get(
  "/supplier-campaigns",
  authenticate,
  requirePermission(PERMISSIONS.CAMPAIGNS_READ),
  listSupplierCampaignsHandler,
);
router.get(
  "/supplier-campaigns/brands",
  authenticate,
  requirePermission(PERMISSIONS.CAMPAIGNS_READ),
  listNetworkBrandsHandler,
);
router.get(
  "/supplier-campaigns/brands/:brandKey",
  authenticate,
  requirePermission(PERMISSIONS.CAMPAIGNS_READ),
  getNetworkBrandWorkspaceHandler,
);
router.get(
  "/master/catalog-summary",
  authenticate,
  requirePermission(PERMISSIONS.CAMPAIGNS_READ),
  masterCatalogSummaryHandler,
);
router.get(
  "/ops/client/guide",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_READ),
  clientOpsGuideHandler,
);
router.get(
  "/ops/network/ai-integration-guide",
  authenticate,
  requirePermission(PERMISSIONS.OPS_READ),
  aiIntegrationGuideHandler,
);
router.get(
  "/ops/global-search",
  authenticate,
  globalSearchHandler,
);
router.get(
  "/supplier-campaigns/:id",
  authenticate,
  requirePermission(PERMISSIONS.CAMPAIGNS_READ),
  getSupplierCampaignHandler,
);
router.post(
  "/supplier-campaigns/promote",
  authenticate,
  requirePermission(PERMISSIONS.SYNC_TRIGGER),
  auditAction("promotion.campaigns", "supplier-campaigns"),
  promoteSupplierCampaignsHandler,
);

router.get(
  "/supplier-coupons",
  authenticate,
  requirePermission(PERMISSIONS.COUPONS_READ),
  listSupplierCouponsHandler,
);

router.post(
  "/promotion/run",
  authenticate,
  requirePermission(PERMISSIONS.SYNC_TRIGGER),
  auditAction("promotion.run", "promotion"),
  runPromotionHandler,
);
router.post(
  "/promotion/retry",
  authenticate,
  requirePermission(PERMISSIONS.SYNC_TRIGGER),
  auditAction("promotion.retry", "promotion"),
  retryPromotionHandler,
);

router.get(
  "/mapper-errors",
  authenticate,
  requirePermission(PERMISSIONS.SYSTEM_READ),
  listMapperErrorsHandler,
);
router.patch(
  "/mapper-errors/:id/retry",
  authenticate,
  requirePermission(PERMISSIONS.SYNC_TRIGGER),
  auditAction("mapper_errors.retry", (req) => `mapper-errors:${req.params.id}`),
  retryMapperErrorHandler,
);

router.get(
  "/merchants",
  authenticate,
  requirePermission(PERMISSIONS.MERCHANTS_READ),
  listMerchantsHandler,
);
router.get(
  "/merchants/:id",
  authenticate,
  requirePermission(PERMISSIONS.MERCHANTS_READ),
  getMerchantHandler,
);
router.post(
  "/merchants",
  authenticate,
  requirePermission(PERMISSIONS.MERCHANTS_MANAGE),
  auditAction("merchants.create", "merchants"),
  createMerchantHandler,
);
router.patch(
  "/merchants/:id",
  authenticate,
  requirePermission(PERMISSIONS.MERCHANTS_MANAGE),
  auditAction("merchants.update", (req) => `merchants:${req.params.id}`),
  updateMerchantHandler,
);
router.post(
  "/merchants/:id/merge",
  authenticate,
  requirePermission(PERMISSIONS.MERCHANTS_MANAGE),
  auditAction("merchants.merge", (req) => `merchants:${req.params.id}`),
  mergeMerchantHandler,
);
router.post(
  "/merchant-matching/run",
  authenticate,
  requirePermission(PERMISSIONS.MERCHANTS_MANAGE),
  auditAction("merchant_matching.run", "merchant-matching"),
  runMerchantMatchingHandler,
);
router.get(
  "/merchant-review",
  authenticate,
  requirePermission(PERMISSIONS.MERCHANTS_READ),
  listMerchantReviewsHandler,
);
router.get(
  "/merchant-review/:id",
  authenticate,
  requirePermission(PERMISSIONS.MERCHANTS_READ),
  getMerchantReviewHandler,
);
router.patch(
  "/merchant-review/:id",
  authenticate,
  requirePermission(PERMISSIONS.MERCHANTS_MANAGE),
  auditAction("merchant_review.update", (req) => `merchant-review:${req.params.id}`),
  updateMerchantReviewHandler,
);

router.get(
  "/catalog",
  authenticate,
  requirePermission(PERMISSIONS.CATALOG_READ),
  listCatalogHandler,
);
router.get(
  "/catalog/:id",
  authenticate,
  requirePermission(PERMISSIONS.CATALOG_READ),
  getCatalogHandler,
);
router.post(
  "/catalog",
  authenticate,
  requirePermission(PERMISSIONS.CATALOG_MANAGE),
  auditAction("catalog.create", "catalog"),
  createCatalogHandler,
);
router.patch(
  "/catalog/:id",
  authenticate,
  requirePermission(PERMISSIONS.CATALOG_MANAGE),
  auditAction("catalog.update", (req) => `catalog:${req.params.id}`),
  updateCatalogHandler,
);
router.post(
  "/catalog/:id/source",
  authenticate,
  requirePermission(PERMISSIONS.CATALOG_MANAGE),
  auditAction("catalog.source.attach", (req) => `catalog:${req.params.id}`),
  attachCatalogSourceHandler,
);
router.patch(
  "/catalog/source/:id",
  authenticate,
  requirePermission(PERMISSIONS.CATALOG_MANAGE),
  auditAction("catalog.source.update", (req) => `catalog:source:${req.params.id}`),
  updateCatalogSourceHandler,
);
router.post(
  "/catalog/source/:id/promote",
  authenticate,
  requirePermission(PERMISSIONS.CATALOG_MANAGE),
  auditAction("catalog.source.promote", (req) => `catalog:source:${req.params.id}`),
  promoteCatalogSourceHandler,
);

router.get(
  "/clients",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_READ),
  listClientsHandler,
);
router.get(
  "/clients/:id",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_READ),
  getClientHandler,
);
router.post(
  "/clients",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_MANAGE),
  auditAction("clients.create", "clients"),
  createClientHandler,
);
router.patch(
  "/clients/:id",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_MANAGE),
  auditAction("clients.update", (req) => `clients:${req.params.id}`),
  updateClientHandler,
);
router.delete(
  "/clients/:id",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_MANAGE),
  auditAction("clients.delete", (req) => `clients:${req.params.id}`),
  deleteClientHandler,
);
router.post(
  "/clients/:id/portal-users",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_MANAGE),
  auditAction("clients.portal_user.create", (req) => `clients:${req.params.id}`),
  createPortalUserHandler,
);
router.get(
  "/clients/:id/portal-users",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_MANAGE),
  listPortalUsersHandler,
);
router.get(
  "/clients/:id/api-keys",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_MANAGE),
  listApiCredentialsHandler,
);
router.post(
  "/clients/:id/api-keys",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_MANAGE),
  auditAction("clients.api_key.create", (req) => `clients:${req.params.id}`),
  createApiCredentialHandler,
);
router.post(
  "/clients/:id/api-keys/:credentialId/revoke",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_MANAGE),
  auditAction("clients.api_key.revoke", (req) => `clients:${req.params.id}`),
  revokeApiCredentialHandler,
);

router.get(
  "/clients/:id/onboarding",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_MANAGE),
  getOnboardingStateHandler,
);
router.put(
  "/clients/:id/onboarding/commercial-model",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_MANAGE),
  auditAction("clients.commercial_model", (req) => `clients:${req.params.id}`),
  setCommercialModelHandler,
);
router.post(
  "/clients/:id/onboarding/admin",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_MANAGE),
  auditAction("clients.onboarding.admin", (req) => `clients:${req.params.id}`),
  inviteAdministratorHandler,
);
router.post(
  "/clients/:id/onboarding/allot",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_MANAGE),
  auditAction("clients.onboarding.allot", (req) => `clients:${req.params.id}`),
  allotCampaignsHandler,
);
router.get(
  "/clients/:id/allocation/campaigns",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_MANAGE),
  listClientAllocationCampaignsHandler,
);
router.get(
  "/clients/:id/allocation/campaigns/:campaignId",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_MANAGE),
  getClientAllocationCampaignHandler,
);
router.post(
  "/clients/:id/onboarding/provision",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_MANAGE),
  auditAction("clients.onboarding.provision", (req) => `clients:${req.params.id}`),
  provisionClientHandler,
);
router.post(
  "/clients/:id/onboarding/activate",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_MANAGE),
  auditAction("clients.onboarding.activate", (req) => `clients:${req.params.id}`),
  activateOnboardingClientHandler,
);

// ---------------------------------------------------------------------------
// Canonical Client API (v15 06C / 09C) — mounted under app /api
// Full paths: /api/v1/client/*
// Single service: PartnerCampaignService / ClientReportingService / PortalDashboardService
// ---------------------------------------------------------------------------
router.get("/v1/client/campaigns", authenticatePartner, requireDeliveryChannel("api"), requireApiEndpoint("campaign"), clientListCampaignsAliasHandler);
router.get("/v1/client/campaigns/:id", authenticatePartner, requireDeliveryChannel("api"), requireApiEndpoint("campaign"), clientGetCampaignAliasHandler);
router.get("/v1/client/account", authenticatePartner, requireDeliveryChannel("api"), requireApiEndpoint("reporting"), clientGetAccountHandler);
router.get("/v1/client/performance", authenticatePartner, requireDeliveryChannel("api"), requireApiEndpoint("reporting"), clientPerformanceAliasHandler);
router.get("/v1/client/performance/summary", authenticatePartner, requireDeliveryChannel("api"), requireApiEndpoint("reporting"), clientPerformanceSummaryHandler);
router.get("/v1/client/performance/campaigns", authenticatePartner, requireDeliveryChannel("api"), requireApiEndpoint("reporting"), clientPerformanceCampaignsHandler);
router.get("/v1/client/performance/affiliate-links", authenticatePartner, requireDeliveryChannel("api"), requireApiEndpoint("reporting"), clientPerformanceAffiliateLinksHandler);
router.get("/v1/client/performance/coupons", authenticatePartner, requireDeliveryChannel("api"), requireApiEndpoint("reporting"), clientPerformanceCouponsHandler);
router.get("/v1/client/performance/orders", authenticatePartner, requireDeliveryChannel("api"), requireApiEndpoint("reporting"), clientPerformanceOrdersHandler);
router.get("/v1/client/orders", authenticatePartner, requireDeliveryChannel("api"), requireApiEndpoint("reporting"), clientListOrdersHandler);
router.get("/v1/client/confirmed-orders", authenticatePartner, requireDeliveryChannel("api"), requireApiEndpoint("reporting"), clientListConfirmedOrdersHandler);
router.get("/v1/client/payments", authenticatePartner, requireDeliveryChannel("api"), requireApiEndpoint("reporting"), clientListPaymentsHandler);
router.get("/v1/client/payouts", authenticatePartner, requireDeliveryChannel("api"), requireApiEndpoint("reporting"), clientListPayoutsHandler);
router.get("/v1/client/statements", authenticatePartner, requireDeliveryChannel("api"), requireApiEndpoint("reporting"), clientListStatementsHandler);
router.get("/v1/client/statements/:id", authenticatePartner, requireDeliveryChannel("api"), requireApiEndpoint("reporting"), clientGetStatementHandler);
router.get("/v1/client/withdrawal-requests", authenticatePartner, requireDeliveryChannel("api"), requireApiEndpoint("reporting"), clientListWithdrawalsHandler);
router.post("/v1/client/withdrawal-requests", authenticatePartner, requireDeliveryChannel("api"), requireApiEndpoint("reporting"), clientCreateWithdrawalHandler);
router.get("/v1/client/products", authenticatePartner, requireDeliveryChannel("api"), requireApiEndpoint("product"), clientListProductsHandler);

// Compatibility aliases — SAME handlers/services as /v1/client/* (do not fork logic).
router.get(
  "/partner/v1/campaigns",
  authenticatePartner,
  requireDeliveryChannel("api"),
  requireApiEndpoint("campaign"),
  auditPartnerAccess("partner.campaigns.list"),
  partnerListCampaignsHandler,
);
router.get(
  "/partner/v1/campaigns/:id",
  authenticatePartner,
  requireDeliveryChannel("api"),
  requireApiEndpoint("campaign"),
  auditPartnerAccess("partner.campaigns.get"),
  partnerGetCampaignHandler,
);
router.get("/partner/v1/orders", authenticatePartner, requireDeliveryChannel("api"), requireApiEndpoint("reporting"), clientListOrdersHandler);
router.get("/partner/v1/confirmed-orders", authenticatePartner, requireDeliveryChannel("api"), requireApiEndpoint("reporting"), clientListConfirmedOrdersHandler);
router.get("/partner/v1/payment-status", authenticatePartner, requireDeliveryChannel("api"), requireApiEndpoint("reporting"), clientListPaymentsHandler);

// Client portal dashboard (JWT CLIENT role or API key — tenant from credential only).
router.get("/portal/v1/me", authenticatePartner, requireDeliveryChannel("portal"), portalMeHandler);
router.get("/portal/v1/overview", authenticatePartner, requireDeliveryChannel("portal"), portalOverviewHandler);
router.get("/portal/v1/performance", authenticatePartner, requireDeliveryChannel("portal"), portalPerformanceHandler);
router.get("/portal/v1/campaigns", authenticatePartner, requireDeliveryChannel("portal"), clientListCampaignsAliasHandler);
router.get("/portal/v1/campaigns/:id", authenticatePartner, requireDeliveryChannel("portal"), clientGetCampaignAliasHandler);
router.get("/portal/v1/orders", authenticatePartner, requireDeliveryChannel("portal"), clientListOrdersHandler);
router.get("/portal/v1/payment-status", authenticatePartner, requireDeliveryChannel("portal"), clientListPaymentsHandler);
router.get("/portal/v1/products", authenticatePartner, requireDeliveryChannel("portal"), clientListProductsHandler);
router.get("/portal/v1/payments", authenticatePartner, requireDeliveryChannel("portal"), portalPaymentsHandler);
router.put("/portal/v1/bank", authenticatePartner, requireDeliveryChannel("portal"), portalSaveBankHandler);
router.post("/portal/v1/withdrawals", authenticatePartner, requireDeliveryChannel("portal"), portalWithdrawHandler);
router.get("/portal/v1/payable-statements", authenticatePartner, requireDeliveryChannel("portal"), portalListPayableStatementsHandler);
router.get("/portal/v1/payable-statements/:id", authenticatePartner, requireDeliveryChannel("portal"), portalGetPayableStatementHandler);
router.get("/portal/v1/withdrawal-requests", authenticatePartner, requireDeliveryChannel("portal"), portalListWithdrawalRequestsHandler);
router.get("/portal/v1/withdrawal-requests/:id", authenticatePartner, requireDeliveryChannel("portal"), portalGetWithdrawalRequestHandler);
router.get("/portal/v1/notifications", authenticatePartner, requireDeliveryChannel("portal"), portalNotificationsHandler);
router.get("/portal/v1/dashboard-summary", authenticatePartner, requireDeliveryChannel("portal"), portalDashboardSummaryHandler);
router.get("/portal/v1/settings", authenticatePartner, requireDeliveryChannel("portal"), portalSettingsGetHandler);
router.patch("/portal/v1/settings", authenticatePartner, requireDeliveryChannel("portal"), portalSettingsPatchHandler);
router.get("/portal/v1/team", authenticatePartner, requireDeliveryChannel("portal"), portalTeamHandler);
router.post("/portal/v1/support", authenticatePartner, requireDeliveryChannel("portal"), portalSupportHandler);
router.get("/portal/v1/api-docs", authenticatePartner, requireDeliveryChannel("portal"), portalApiDocsHandler);
router.get("/portal/v1/api-keys", authenticatePartner, requireDeliveryChannel("portal"), portalListApiKeysHandler);
router.post("/portal/v1/api-keys/rotate", authenticatePartner, requireDeliveryChannel("portal"), portalRotateApiKeyHandler);

router.get(
  "/client-brand-requests",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_READ),
  listBrandRequestsHandler,
);
router.post(
  "/client-brand-requests",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_MANAGE),
  auditAction("client_brand_requests.create", "client-brand-requests"),
  createBrandRequestHandler,
);
router.patch(
  "/client-brand-requests/:id",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_MANAGE),
  auditAction("client_brand_requests.update", (req) => `client-brand-requests:${req.params.id}`),
  updateBrandRequestHandler,
);

router.get(
  "/client-assignments",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_READ),
  listAssignmentsHandler,
);
router.post(
  "/client-assignments",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_MANAGE),
  auditAction("client_assignments.create", "client-assignments"),
  createAssignmentHandler,
);
router.patch(
  "/client-assignments/:id",
  authenticate,
  requirePermission(PERMISSIONS.CLIENTS_MANAGE),
  auditAction("client_assignments.update", (req) => `client-assignments:${req.params.id}`),
  updateAssignmentHandler,
);

router.get(
  "/tracking-links",
  authenticate,
  requirePermission(PERMISSIONS.TRACKING_READ),
  listTrackingLinksHandler,
);
router.get(
  "/tracking-links/defaults",
  authenticate,
  requirePermission(PERMISSIONS.TRACKING_READ),
  getTrackingLinkDefaultsHandler,
);
router.post(
  "/tracking-links",
  authenticate,
  requirePermission(PERMISSIONS.TRACKING_MANAGE),
  auditAction("tracking_links.create", "tracking-links"),
  createTrackingLinkHandler,
);
router.patch(
  "/tracking-links/:id",
  authenticate,
  requirePermission(PERMISSIONS.TRACKING_MANAGE),
  auditAction("tracking_links.update", (req) => `tracking-links:${req.params.id}`),
  updateTrackingLinkHandler,
);

router.get(
  "/coupon-assignments",
  authenticate,
  requirePermission(PERMISSIONS.COUPON_ASSIGN_READ),
  listCouponAssignmentsHandler,
);
router.post(
  "/coupon-assignments",
  authenticate,
  requirePermission(PERMISSIONS.COUPON_ASSIGN_MANAGE),
  auditAction("coupon_assignments.create", "coupon-assignments"),
  createCouponAssignmentHandler,
);
router.patch(
  "/coupon-assignments/:id",
  authenticate,
  requirePermission(PERMISSIONS.COUPON_ASSIGN_MANAGE),
  auditAction("coupon_assignments.update", (req) => `coupon-assignments:${req.params.id}`),
  updateCouponAssignmentHandler,
);

router.get(
  "/commission-rules",
  authenticate,
  requirePermission(PERMISSIONS.COMMISSION_READ),
  listCommissionRulesHandler,
);
router.post(
  "/commission-rules",
  authenticate,
  requirePermission(PERMISSIONS.COMMISSION_MANAGE),
  auditAction("commission_rules.create", "commission-rules"),
  createCommissionRuleHandler,
);
router.patch(
  "/commission-rules/:id",
  authenticate,
  requirePermission(PERMISSIONS.COMMISSION_MANAGE),
  auditAction("commission_rules.update", (req) => `commission-rules:${req.params.id}`),
  updateCommissionRuleHandler,
);

router.get(
  "/clicks",
  authenticate,
  requirePermission(PERMISSIONS.TRACKING_READ),
  listClicksHandler,
);
router.post(
  "/clicks",
  authenticate,
  requirePermission(PERMISSIONS.TRACKING_MANAGE),
  auditAction("clicks.record", "clicks"),
  recordClickHandler,
);

router.get(
  "/conversions",
  authenticate,
  requirePermission(PERMISSIONS.CONVERSIONS_READ),
  listConversionsHandler,
);
router.post(
  "/conversions",
  authenticate,
  requirePermission(PERMISSIONS.SYNC_TRIGGER),
  auditAction("conversions.ingest", "conversions"),
  ingestConversionHandler,
);

router.get(
  "/reports/daily",
  authenticate,
  requirePermission(PERMISSIONS.PERFORMANCE_READ),
  listDailyReportsHandler,
);
router.get(
  "/reports/client",
  authenticate,
  requirePermission(PERMISSIONS.PERFORMANCE_READ),
  listClientReportsHandler,
);
router.get(
  "/reports/merchant",
  authenticate,
  requirePermission(PERMISSIONS.PERFORMANCE_READ),
  listMerchantReportsHandler,
);
router.get(
  "/reports/campaign",
  authenticate,
  requirePermission(PERMISSIONS.PERFORMANCE_READ),
  listCampaignReportsHandler,
);
router.get(
  "/reports/source",
  authenticate,
  requirePermission(PERMISSIONS.PERFORMANCE_READ),
  listSourceReportsHandler,
);

router.post(
  "/aggregation/run",
  authenticate,
  requirePermission(PERMISSIONS.SYNC_TRIGGER),
  auditAction("aggregation.run", "aggregation"),
  runAggregationHandler,
);
router.post(
  "/aggregation/rebuild",
  authenticate,
  requirePermission(PERMISSIONS.SYNC_TRIGGER),
  auditAction("aggregation.rebuild", "aggregation"),
  rebuildAggregationHandler,
);

router.get(
  "/ops/metrics",
  authenticate,
  requirePermission(PERMISSIONS.OPS_READ),
  systemMetricsHandler,
);
router.get(
  "/ops/queues",
  authenticate,
  requirePermission(PERMISSIONS.OPS_READ),
  queueStatusHandler,
);
router.get(
  "/ops/jobs/failed",
  authenticate,
  requirePermission(PERMISSIONS.OPS_READ),
  failedJobsHandler,
);
router.get(
  "/ops/jobs/dead-letter",
  authenticate,
  requirePermission(PERMISSIONS.OPS_READ),
  deadLetterHandler,
);
router.get(
  "/ops/aggregation",
  authenticate,
  requirePermission(PERMISSIONS.OPS_READ),
  aggregationStatusHandler,
);
router.get(
  "/ops/promotion",
  authenticate,
  requirePermission(PERMISSIONS.OPS_READ),
  promotionStatusHandler,
);
router.get(
  "/ops/matching-queue",
  authenticate,
  requirePermission(PERMISSIONS.OPS_READ),
  matchingQueueHandler,
);
router.get(
  "/ops/storage",
  authenticate,
  requirePermission(PERMISSIONS.OPS_READ),
  storageUsageHandler,
);
router.get(
  "/ops/database",
  authenticate,
  requirePermission(PERMISSIONS.OPS_READ),
  databaseStatsHandler,
);
router.get(
  "/ops/workers",
  authenticate,
  requirePermission(PERMISSIONS.OPS_READ),
  workerStatusHandler,
);
router.post(
  "/ops/outbox/dispatch",
  authenticate,
  requirePermission(PERMISSIONS.OPS_READ),
  auditAction("ops.outbox.dispatch", "event-outbox"),
  dispatchOutboxHandler,
);

// Wave G — operational APIs
router.get("/ops/exceptions", authenticate, requirePermission(PERMISSIONS.EXCEPTIONS_READ), listExceptionsHandler);
router.get("/ops/exceptions/:id", authenticate, requirePermission(PERMISSIONS.EXCEPTIONS_READ), getExceptionHandler);
router.post("/ops/exceptions/:id/acknowledge", authenticate, requirePermission(PERMISSIONS.EXCEPTIONS_MANAGE), auditAction("exception.acknowledge", "ExceptionCase"), acknowledgeExceptionHandler);
router.post("/ops/exceptions/:id/assign", authenticate, requirePermission(PERMISSIONS.EXCEPTIONS_MANAGE), auditAction("exception.assign", "ExceptionCase"), assignExceptionHandler);
router.post("/ops/exceptions/:id/resolve", authenticate, requirePermission(PERMISSIONS.EXCEPTIONS_MANAGE), auditAction("exception.resolve", "ExceptionCase"), resolveExceptionHandler);
router.post("/ops/exceptions/:id/reopen", authenticate, requirePermission(PERMISSIONS.EXCEPTIONS_MANAGE), auditAction("exception.reopen", "ExceptionCase"), reopenExceptionHandler);
router.post("/ops/exceptions/:id/retry", authenticate, requirePermission(PERMISSIONS.EXCEPTIONS_MANAGE), auditAction("exception.retry", "ExceptionCase"), retryExceptionHandler);

router.get("/ops/mapping-review", authenticate, requirePermission(PERMISSIONS.EXCEPTIONS_READ), listMappingReviewHandler);
router.get("/ops/raw-payloads", authenticate, requirePermission(PERMISSIONS.OPS_READ), listRawPayloadsHandler);
router.get("/ops/raw-payloads/:id", authenticate, requirePermission(PERMISSIONS.OPS_READ), getRawPayloadHandler);
router.post("/ops/raw-payloads/:id/replay", authenticate, requirePermission(PERMISSIONS.OPS_MANAGE), auditAction("mapping.replay", "RawPayload"), replayRawPayloadHandler);
router.post("/ops/reprocess", authenticate, requirePermission(PERMISSIONS.OPS_MANAGE), auditAction("reprocess.batch", "RawPayload"), reprocessHandler);
router.get("/ops/sync-runs", authenticate, requirePermission(PERMISSIONS.OPS_READ), listSyncRunsHandler);
router.get("/ops/sync-runs/:id", authenticate, requirePermission(PERMISSIONS.OPS_READ), getSyncRunHandler);

router.get("/ops/finance/dashboard", authenticate, requirePermission(PERMISSIONS.FINANCE_OPS_READ), financeDashboardHandler);
router.get("/ops/finance/reconcile/transaction/:id", authenticate, requirePermission(PERMISSIONS.FINANCE_OPS_READ), reconcileTransactionHandler);
router.get("/ops/finance/reconcile/conversion/:conversionId", authenticate, requirePermission(PERMISSIONS.FINANCE_OPS_READ), reconcileConversionHandler);
router.get("/ops/finance/reconcile/client/:clientId", authenticate, requirePermission(PERMISSIONS.FINANCE_OPS_READ), reconcileClientHandler);
router.get("/ops/finance/reconcile/supplier/:supplier", authenticate, requirePermission(PERMISSIONS.FINANCE_OPS_READ), reconcileSupplierHandler);
router.get("/ops/finance/portal-cutover-readiness", authenticate, requirePermission(PERMISSIONS.FINANCE_OPS_READ), portalCutoverReadinessHandler);
router.get("/ops/finance/daily-report-cutover-readiness", authenticate, requirePermission(PERMISSIONS.FINANCE_OPS_READ), dailyReportCutoverReadinessHandler);
router.get("/ops/finance/historical-coverage", authenticate, requirePermission(PERMISSIONS.FINANCE_OPS_READ), historicalFinanceCoverageHandler);

router.get("/ops/products", authenticate, requirePermission(PERMISSIONS.PRODUCTS_READ), listProductsHandler);
router.post("/ops/products/sync-feeds", authenticate, requirePermission(PERMISSIONS.PRODUCTS_READ), syncProductFeedsHandler);
router.get("/ops/products/:id", authenticate, requirePermission(PERMISSIONS.PRODUCTS_READ), getProductHandler);
router.get("/ops/product-feeds", authenticate, requirePermission(PERMISSIONS.PRODUCTS_READ), listProductFeedsHandler);
router.post("/ops/product-feeds/ingest", authenticate, requirePermission(PERMISSIONS.PRODUCTS_READ), ingestProductFeedHandler);
router.post("/ops/client-products/assign", authenticate, requirePermission(PERMISSIONS.PRODUCTS_READ), assignClientProductHandler);

/** Epic 7 — staff admin contracts (v15 03A / 04A / 07E oriented). CLIENT role denied via permissions. */
router.get("/ops/admin/campaigns", authenticate, requirePermission(PERMISSIONS.CATALOG_READ), adminListCampaignsHandler);
router.get("/ops/admin/campaigns/:id", authenticate, requirePermission(PERMISSIONS.CATALOG_READ), adminGetCampaignHandler);
router.post(
  "/ops/admin/campaigns/supplier/:supplierCampaignId/certify-mapping",
  authenticate,
  requirePermission(PERMISSIONS.OPS_MANAGE),
  auditAction("network.mapping.certify", "MappingCertification"),
  certifyMappingHandler,
);
router.post(
  "/ops/admin/campaigns/supplier/:supplierCampaignId/revoke-mapping",
  authenticate,
  requirePermission(PERMISSIONS.OPS_MANAGE),
  auditAction("network.mapping.revoke", "MappingCertification"),
  revokeMappingHandler,
);
router.post(
  "/ops/admin/campaigns/approve-catalog",
  authenticate,
  requirePermission(PERMISSIONS.CATALOG_MANAGE),
  auditAction("network.catalog.approve", "CanonicalCampaign"),
  approveCatalogHandler,
);
router.get("/ops/admin/performance", authenticate, requirePermission(PERMISSIONS.PERFORMANCE_READ), adminListPerformanceHandler);
router.get("/ops/admin/client-overview", authenticate, requirePermission(PERMISSIONS.PERFORMANCE_READ), adminListClientOverviewHandler);
router.get("/ops/admin/client-performance", authenticate, requirePermission(PERMISSIONS.PERFORMANCE_READ), adminListClientPerformanceHandler);
router.get("/ops/admin/client-confirmed-orders", authenticate, requirePermission(PERMISSIONS.CONVERSIONS_READ), adminListClientConfirmedOrdersHandler);
router.get("/ops/admin/reporting-overview", authenticate, requirePermission(PERMISSIONS.PERFORMANCE_READ), adminReportingOverviewHandler);
router.get("/ops/admin/orders", authenticate, requirePermission(PERMISSIONS.CONVERSIONS_READ), adminListOrdersHandler);
router.post(
  "/ops/admin/order-items/:id/validation",
  authenticate,
  requirePermission(PERMISSIONS.OPS_MANAGE),
  auditAction("order_item.validation", "OrderItem"),
  adminTransitionOrderItemValidationHandler,
);
router.get("/ops/admin/product-feeds", authenticate, requirePermission(PERMISSIONS.PRODUCTS_READ), adminListProductFeedsHandler);
router.get("/ops/admin/commission-vocabulary", authenticate, requirePermission(PERMISSIONS.COMMISSION_READ), adminCommissionVocabularyHandler);
router.get(
  "/ops/admin/payment-status",
  authenticate,
  requirePermission(PERMISSIONS.FINANCE_OPS_READ),
  adminListPaymentStatusHandler,
);
router.get(
  "/ops/admin/network-billing",
  authenticate,
  requirePermission(PERMISSIONS.FINANCE_OPS_READ),
  adminListNetworkBillingHandler,
);
router.get(
  "/ops/admin/network-payments-received",
  authenticate,
  requirePermission(PERMISSIONS.FINANCE_OPS_READ),
  adminListNetworkPaymentsReceivedHandler,
);
router.get(
  "/ops/admin/mbo-receipts",
  authenticate,
  requirePermission(PERMISSIONS.FINANCE_OPS_READ),
  adminListMboReceiptsHandler,
);
router.get(
  "/ops/admin/client-settlements/payable-orders",
  authenticate,
  requirePermission(PERMISSIONS.FINANCE_OPS_READ),
  adminListPayableOrdersHandler,
);
router.get(
  "/ops/admin/client-settlements/withdrawal-invoice-requests",
  authenticate,
  requirePermission(PERMISSIONS.FINANCE_OPS_READ),
  adminListWithdrawalInvoiceRequestsHandler,
);
router.get(
  "/ops/admin/client-settlements/payouts",
  authenticate,
  requirePermission(PERMISSIONS.FINANCE_OPS_READ),
  adminListPayoutsHandler,
);

/** Boostiny Partner Payment CSV — aggregate settlement only (never fake individual orders). */
router.get(
  "/ops/admin/boostiny/payment-source-mappings",
  authenticate,
  requirePermission(PERMISSIONS.FINANCE_OPS_READ),
  boostinyListPaymentMappingsHandler,
);
router.put(
  "/ops/admin/boostiny/payment-source-mappings",
  authenticate,
  requirePermission(PERMISSIONS.FINANCE_OPS_READ),
  auditAction("boostiny.payment_source_mapping.upsert", "BoostinyPaymentSourceMapping"),
  boostinyUpsertPaymentMappingHandler,
);
router.get(
  "/ops/admin/boostiny/partner-payment-settlements",
  authenticate,
  requirePermission(PERMISSIONS.FINANCE_OPS_READ),
  boostinyListPartnerSettlementsHandler,
);
router.post(
  "/ops/admin/boostiny/partner-payment-upload",
  authenticate,
  requirePermission(PERMISSIONS.FINANCE_OPS_READ),
  auditAction("boostiny.partner_payment.upload", "BoostinyPartnerPaymentUpload"),
  boostinyUploadPartnerPaymentHandler,
);

/** Thin alias — same handler as /ops/admin/product-feeds */
router.get("/ops/admin/feeds", authenticate, requirePermission(PERMISSIONS.PRODUCTS_READ), adminListProductFeedsHandler);

router.get("/ops/data-quality", authenticate, requirePermission(PERMISSIONS.OPS_READ), dataQualityHandler);
router.get("/ops/assignment-coverage", authenticate, requirePermission(PERMISSIONS.OPS_READ), assignmentCoverageHandler);
router.get("/ops/supplier-health", authenticate, requirePermission(PERMISSIONS.OPS_READ), supplierHealthHandler);
router.get("/ops/job-health", authenticate, requirePermission(PERMISSIONS.OPS_READ), jobHealthHandler);
router.get("/ops/system-health", authenticate, requirePermission(PERMISSIONS.OPS_READ), systemOpsHealthHandler);

/** Network R/C/P reconciliation — same page domain as FT identity (/ops/reconciliation). */
router.get(
  "/ops/finance/reconcile/network",
  authenticate,
  requirePermission(PERMISSIONS.FINANCE_OPS_READ),
  networkReconHandler,
);
router.post(
  "/ops/finance/reconcile/network/rebuild",
  authenticate,
  requirePermission(PERMISSIONS.FINANCE_OPS_READ),
  auditAction("network.reconciliation.rebuild", "NetworkReconciliationRow"),
  rebuildNetworkReconHandler,
);
router.get(
  "/ops/mapping-review/rules",
  authenticate,
  requirePermission(PERMISSIONS.OPS_READ),
  mappingRulesHandler,
);
router.get(
  "/ops/mapping-registry",
  authenticate,
  requirePermission(PERMISSIONS.OPS_READ),
  listMappingRegistryHandler,
);
router.get(
  "/ops/mapping-registry/:id",
  authenticate,
  requirePermission(PERMISSIONS.OPS_READ),
  getMappingRegistryRuleHandler,
);
router.post(
  "/ops/mapping-registry/sync",
  authenticate,
  requirePermission(PERMISSIONS.OPS_READ),
  syncMappingRegistryHandler,
);
router.get(
  "/ops/network/dashboard",
  authenticate,
  requirePermission(PERMISSIONS.CAMPAIGNS_READ),
  networkOpsDashboardHandler,
);
router.get(
  "/ops/admin/supplier-commission-rules",
  authenticate,
  requirePermission(PERMISSIONS.COMMISSION_READ),
  supplierCommissionRulesHandler,
);
router.post(
  "/ops/admin/supplier-commission-rules/test",
  authenticate,
  requirePermission(PERMISSIONS.COMMISSION_MANAGE),
  auditAction("supplier_commission_rules.test_create", "SupplierCommissionRule"),
  createTestSupplierCommissionRuleHandler,
);
router.get(
  "/ops/admin/tracking-links",
  authenticate,
  requirePermission(PERMISSIONS.TRACKING_READ),
  networkTrackingLinksHandler,
);

export default router;
