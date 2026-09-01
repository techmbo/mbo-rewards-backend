import { SOURCE_TIERS } from "../constants.js";

function isRoutableSource(source) {
  return source.isActive && source.status !== "DEPRECATED" && source.relationshipStatus === "JOINED";
}

function compareSources(a, b) {
  if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
  if (a.priority !== b.priority) return a.priority - b.priority;
  return new Date(a.createdAt) - new Date(b.createdAt);
}

export class SourceSelectionService {
  /**
   * Resolves primary, secondary, and inactive sources for routing.
   * Recommendation is a placeholder for future optimisation (not implemented).
   */
  select(sources = []) {
    const sorted = [...sources].sort(compareSources);
    const routable = sorted.filter(isRoutableSource);
    const inactive = sorted.filter((source) => !isRoutableSource(source));

    const primary = routable.find((source) => source.isPrimary) ?? routable[0] ?? null;
    const secondary = routable.filter((source) => source.id !== primary?.id);

    return {
      primary,
      secondary,
      inactive,
      recommendation: null,
      tier: primary ? SOURCE_TIERS.PRIMARY : SOURCE_TIERS.INACTIVE,
    };
  }

  detectConflicts(sources = []) {
    const conflicts = [];
    const primaries = sources.filter((source) => source.isPrimary && source.isActive);

    if (primaries.length > 1) {
      conflicts.push({
        code: "MULTIPLE_PRIMARY",
        message: "More than one active primary source is configured.",
        sourceIds: primaries.map((source) => source.id),
      });
    }

    const activeWithoutJoin = sources.filter(
      (source) => source.isActive && source.relationshipStatus !== "JOINED",
    );
    if (activeWithoutJoin.length) {
      conflicts.push({
        code: "ACTIVE_NOT_JOINED",
        message: "Active sources exist without JOINED relationship status.",
        sourceIds: activeWithoutJoin.map((source) => source.id),
      });
    }

    return conflicts;
  }
}
