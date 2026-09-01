-- Pointer 6: Versioned Mapping Registry

CREATE TABLE IF NOT EXISTS "MappingRegistryRule" (
  "id" TEXT NOT NULL,
  "network" TEXT NOT NULL,
  "networkAccountScope" TEXT NOT NULL DEFAULT '',
  "networkProfile" TEXT NOT NULL DEFAULT '',
  "sourceObject" TEXT NOT NULL,
  "endpointOrReport" TEXT,
  "sourcePath" TEXT NOT NULL,
  "sourceType" TEXT,
  "sampleRawValue" TEXT,
  "mboTargetObject" TEXT NOT NULL,
  "mboCanonicalField" TEXT NOT NULL,
  "transform" TEXT,
  "enumMap" JSONB,
  "fallbackSourcePaths" JSONB,
  "conditions" JSONB,
  "mappingStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
  "mappingVersion" TEXT NOT NULL,
  "definitionVersion" TEXT,
  "verificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
  "sourceFile" TEXT,
  "required" BOOLEAN NOT NULL DEFAULT false,
  "ruleType" TEXT,
  "notes" TEXT,
  "firstSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MappingRegistryRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MappingRegistryRule_network_sourceObject_sourcePath_mappingVersion_networkAccountScope_networkProfile_key"
  ON "MappingRegistryRule"("network", "sourceObject", "sourcePath", "mappingVersion", "networkAccountScope", "networkProfile");

CREATE INDEX IF NOT EXISTS "MappingRegistryRule_network_sourceObject_idx"
  ON "MappingRegistryRule"("network", "sourceObject");

CREATE INDEX IF NOT EXISTS "MappingRegistryRule_mappingVersion_idx"
  ON "MappingRegistryRule"("mappingVersion");

CREATE INDEX IF NOT EXISTS "MappingRegistryRule_mboCanonicalField_idx"
  ON "MappingRegistryRule"("mboCanonicalField");

CREATE INDEX IF NOT EXISTS "MappingRegistryRule_mappingStatus_idx"
  ON "MappingRegistryRule"("mappingStatus");
