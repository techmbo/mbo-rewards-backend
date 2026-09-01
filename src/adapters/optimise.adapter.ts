export type OptimiseAdapter = {
  fetchCampaigns: (params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
  fetchCampaignDetail: (campaignId: string) => Promise<Record<string, unknown>>;
  fetchConversions: (params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
  fetchPayments: (params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
  fetchReporting: (params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
  fetchInvoiceReporting: (params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
  fetchVoucherCodes: (params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
  fetchAll: (
    params?: Record<string, Record<string, unknown>>,
  ) => Promise<{
    campaigns: Record<string, unknown>[];
    campaignDetails: Record<string, unknown>[];
    conversions: Record<string, unknown>[];
    conversionsByPayment: Record<string, unknown>[];
    reporting: Record<string, unknown>[];
    invoiceReporting: Record<string, unknown>[];
    payments: Record<string, unknown>[];
    voucherCodes: Record<string, unknown>[];
  }>;
};
