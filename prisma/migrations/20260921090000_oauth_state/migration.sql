-- Durable, single-use OAuth `state` for the marketplace connect flow.
-- Additive only: no existing table, column or row is altered.
--
-- The marketplace callback is public, so the `state` it receives is attacker-supplied text. This
-- table makes that string verifiable: the nonce is stored hashed, and "consumedAt" makes each
-- issued state usable exactly once.

CREATE TABLE "OAuthState" (
  "id"                TEXT         NOT NULL,
  "nonceHash"         TEXT         NOT NULL,
  "platform"          TEXT         NOT NULL,
  "accountLabel"      TEXT         NOT NULL DEFAULT 'default',
  "initiatedByUserId" TEXT,
  "expiresAt"         TIMESTAMP(3) NOT NULL,
  "consumedAt"        TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("id")
);

-- The lookup key for an inbound callback. Unique so a nonce can never resolve to two rows.
CREATE UNIQUE INDEX "OAuthState_nonceHash_key" ON "OAuthState"("nonceHash");

-- Supports expiry sweeps.
CREATE INDEX "OAuthState_expiresAt_idx" ON "OAuthState"("expiresAt");
