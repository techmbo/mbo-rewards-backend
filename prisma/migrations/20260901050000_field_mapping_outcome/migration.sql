ALTER TABLE "MappingRegistryRule" ADD COLUMN IF NOT EXISTS "fieldMappingOutcome" TEXT;

CREATE INDEX IF NOT EXISTS "MappingRegistryRule_fieldMappingOutcome_idx"
  ON "MappingRegistryRule"("fieldMappingOutcome");

UPDATE "MappingRegistryRule"
SET "fieldMappingOutcome" = 'SOURCE_PRESENT_MAPPING_MISSING'
WHERE "mappingStatus" = 'GAP' AND ("fieldMappingOutcome" IS NULL OR "fieldMappingOutcome" = '');

UPDATE "MappingRegistryRule"
SET "fieldMappingOutcome" = 'MAPPED'
WHERE "mappingStatus" = 'ACTIVE'
  AND "mboCanonicalField" IS NOT NULL
  AND "mboCanonicalField" <> ''
  AND ("fieldMappingOutcome" IS NULL OR "fieldMappingOutcome" = '');
