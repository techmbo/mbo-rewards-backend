import { ConversionPromotionService } from "../modules/reporting/services/conversionPromotion.service.js";

export class ConversionPromotionJob {
  constructor(deps = {}) {
    this.service = deps.service ?? new ConversionPromotionService();
  }

  async run(payload = {}) {
    return this.service.run(payload);
  }
}
