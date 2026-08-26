import { AggregationService } from "../modules/reporting/services/aggregation.service.js";
import { AttributionService } from "../modules/reporting/services/attribution.service.js";
import { ConversionRepository } from "../modules/reporting/repositories/reporting.repository.js";

export class AggregationJob {
  constructor(deps = {}) {
    this.aggregationService = deps.aggregationService ?? new AggregationService();
    this.attributionService = deps.attributionService ?? new AttributionService();
    this.conversionRepo = deps.conversionRepo ?? new ConversionRepository();
  }

  async run({ date, from, to, clientId, retryFailed = false } = {}) {
    const startedAt = Date.now();

    if (retryFailed) {
      await this.retryPendingAttribution();
    }

    let result;
    if (date) {
      result = await this.aggregationService.runForDate(date, { clientId });
    } else if (from && to) {
      result = await this.aggregationService.rebuild({ from, to, clientId });
    } else {
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      result = await this.aggregationService.runForDate(yesterday, { clientId });
    }

    return {
      ...result,
      durationMs: Date.now() - startedAt,
    };
  }

  async rebuild(input = {}) {
    const startedAt = Date.now();
    const result = await this.aggregationService.rebuild(input);
    return { ...result, durationMs: Date.now() - startedAt };
  }

  async retryPendingAttribution() {
    const pending = await this.conversionRepo.findPendingAttribution({ take: 500 });
    for (const conversion of pending) {
      await this.attributionService.attributeConversion(conversion.id);
    }
    return { retried: pending.length };
  }
}
