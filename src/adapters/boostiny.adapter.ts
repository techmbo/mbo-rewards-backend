export type FetchPaginatedResult<T = Record<string, unknown>> = {
  rows: T[];
  pages: Record<string, unknown>[];
};

export type BoostinyAdapter = {
  fetchCampaigns: (params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
  fetchPerformance: (params?: Record<string, unknown>) => Promise<FetchPaginatedResult>;
  fetchLinkPerformance: (params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
  fetchCoupons: (params?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;
  fetchAll: (
    params?: Record<string, Record<string, unknown>>,
  ) => Promise<{
    campaigns: Record<string, unknown>[];
    performanceRows: Record<string, unknown>[];
    performancePages: Record<string, unknown>[];
    linkPerformance: Record<string, unknown>[];
    coupons: Record<string, unknown>[];
  }>;
};
