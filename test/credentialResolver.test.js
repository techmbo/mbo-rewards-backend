import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CREDENTIAL_SLOTS,
  NETWORK_CREDENTIAL_CATALOG,
  credentialProfile,
} from "../src/modules/integrations/credentials/credentialCatalog.js";
import {
  CREDENTIAL_PROVIDER_NAMES,
  CredentialResolutionError,
  buildSecretRef,
  createAwsSecretsManagerProvider,
  createEnvCredentialProvider,
  describeSecretRef,
  isProviderSecretRef,
  legacyEnvCredential,
  parseSecretRef,
  registerCredentialProvider,
  registeredCredentialProviders,
  resetCredentialProvidersForTests,
  resolveCredentialSlots,
  validateSecretRef,
} from "../src/modules/integrations/credentials/credentialResolver.js";

const S = CREDENTIAL_SLOTS;

afterEach(() => resetCredentialProvidersForTests());

/** An env source that records every name it is asked for. */
function recordingEnv(values) {
  const asked = [];
  const source = new Proxy(values, {
    get(target, name) {
      asked.push(name);
      return target[name];
    },
  });
  return { source, asked };
}

describe("the fixed per-network allow-list", () => {
  it("covers exactly the rollout networks, with the env names production reads today", () => {
    assert.deepEqual(Object.keys(NETWORK_CREDENTIAL_CATALOG).sort(), [
      "awin", "boostiny", "impact", "optimise_mena", "optimise_sea", "optimise_uk", "partnerize", "trackier",
    ]);
    assert.equal(credentialProfile("optimise_sea").slots[S.PRIMARY_SECRET].env, "OPTIMISE_API_KEY");
    assert.equal(credentialProfile("optimise_sea").slots[S.CONTACT_ID].env, "OPTIMISE_SEA_CONTACT_ID");
    assert.equal(credentialProfile("trackier").slots[S.PRIMARY_SECRET].env, "VCOMMISSION_API_KEY");
    assert.equal(credentialProfile("impact").slots[S.SECONDARY_SECRET].env, "IMPACT_AUTH_TOKEN");
  });

  it("is frozen and refuses prototype keys and unknown platforms", () => {
    assert.ok(Object.isFrozen(NETWORK_CREDENTIAL_CATALOG));
    assert.ok(Object.isFrozen(NETWORK_CREDENTIAL_CATALOG.awin.slots));
    for (const bad of ["__proto__", "constructor", "toString", "cj", "rakuten", "", null, "OPTIMISE_API_KEY"]) {
      assert.equal(credentialProfile(bad), null, String(bad));
    }
  });
});

describe("the env provider reads catalogued names only", () => {
  it("reads the platform's own names and nothing else", async () => {
    const { source, asked } = recordingEnv({ OPTIMISE_API_KEY: " k-sea ", OPTIMISE_SEA_CONTACT_ID: "77", OPTIMISE_MENA_API_KEY: "k-mena" });
    registerCredentialProvider(createEnvCredentialProvider({ envSource: source }));
    const { values, missingRequired, provider } = await resolveCredentialSlots({
      platform: "optimise_sea",
      secretRef: "env:optimise_sea",
    });
    assert.equal(provider, "env");
    assert.deepEqual(values, { [S.PRIMARY_SECRET]: "k-sea", [S.CONTACT_ID]: "77" });
    assert.deepEqual(missingRequired, []);
    assert.deepEqual(asked.sort(), ["OPTIMISE_API_KEY", "OPTIMISE_SEA_CONTACT_ID"]);
  });

  it("reports missing required slots by slot name, never by variable name", async () => {
    registerCredentialProvider(createEnvCredentialProvider({ envSource: {} }));
    const { missingRequired } = await resolveCredentialSlots({ platform: "awin", secretRef: "env:awin" });
    assert.deepEqual(missingRequired.sort(), [S.ACCOUNT_EXTERNAL_ID, S.PRIMARY_SECRET].sort());
  });

  it("a slot outside the platform's profile is never looked up", async () => {
    const { source, asked } = recordingEnv({ BOOSTINY_API_KEY: "b" });
    registerCredentialProvider(createEnvCredentialProvider({ envSource: source }));
    const { values } = await resolveCredentialSlots({
      platform: "boostiny",
      secretRef: "env:boostiny",
      slots: [S.PRIMARY_SECRET, S.SECONDARY_SECRET, "DATABASE_URL"],
    });
    assert.deepEqual(values, { [S.PRIMARY_SECRET]: "b" });
    assert.deepEqual(asked, ["BOOSTINY_API_KEY"]);
  });
});

describe("tampered or foreign references are refused before any lookup", () => {
  const cases = [
    ["another platform's reference", "env:optimise_mena", "reference_platform_mismatch"],
    ["an arbitrary env name", "env:DATABASE_URL", "reference_platform_mismatch"],
    ["an unknown provider", "vault:optimise_sea", "not_a_provider_reference"],
    ["the legacy encrypted placeholder", "mbo-sm://local-encrypted/network-account/x", "not_a_provider_reference"],
    ["an empty reference", "env:", "not_a_provider_reference"],
    ["a non-string", 42, "not_a_provider_reference"],
  ];
  for (const [label, ref, reason] of cases) {
    it(label, async () => {
      const { source, asked } = recordingEnv({ OPTIMISE_API_KEY: "k", DATABASE_URL: "postgres://x" });
      registerCredentialProvider(createEnvCredentialProvider({ envSource: source }));
      assert.equal(validateSecretRef(ref, { platform: "optimise_sea" }).reason, reason);
      await assert.rejects(
        resolveCredentialSlots({ platform: "optimise_sea", secretRef: ref }),
        (error) => error instanceof CredentialResolutionError && error.code === reason,
      );
      assert.deepEqual(asked, []);
    });
  }

  it("an AWS reference that is not the canonical id for this connection is refused", async () => {
    let fetched = 0;
    registerCredentialProvider(createAwsSecretsManagerProvider({ fetchSecretString: async () => { fetched += 1; return "{}"; } }));
    for (const ref of [
      "aws-sm:mbo/production/networks/optimise_mena/default",
      "aws-sm:mbo/production/networks/optimise_sea/other",
      "aws-sm:mbo/sandbox/networks/optimise_sea/default",
      "aws-sm:arn:aws:secretsmanager:eu-west-1:1:secret:prod-db",
    ]) {
      await assert.rejects(resolveCredentialSlots({ platform: "optimise_sea", secretRef: ref }), /not valid/);
    }
    assert.equal(fetched, 0);
  });

  it("an unknown platform is refused", async () => {
    await assert.rejects(resolveCredentialSlots({ platform: "cj", secretRef: "env:cj" }), (e) => e.code === "platform_not_allowed");
  });
});

describe("buildSecretRef — the server builds the only acceptable reference", () => {
  it("builds env and AWS references from platform, label and environment", () => {
    assert.equal(buildSecretRef({ provider: "env", platform: "optimise_sea", accountLabel: "default" }), "env:optimise_sea");
    registerCredentialProvider(createAwsSecretsManagerProvider({ fetchSecretString: async () => "{}" }));
    assert.equal(
      buildSecretRef({ provider: "aws-sm", platform: "Optimise_SEA", accountLabel: "Main", environment: "PRODUCTION" }),
      "aws-sm:mbo/production/networks/optimise_sea/main",
    );
  });

  it("refuses unknown platforms, bad labels, bad environments and unregistered providers", () => {
    const code = (fn) => {
      try {
        fn();
      } catch (error) {
        return error.code;
      }
      return null;
    };
    assert.equal(code(() => buildSecretRef({ provider: "env", platform: "rakuten" })), "platform_not_allowed");
    assert.equal(code(() => buildSecretRef({ provider: "env", platform: "awin", accountLabel: "../x" })), "invalid_account_label");
    assert.equal(code(() => buildSecretRef({ provider: "env", platform: "awin", environment: "staging" })), "invalid_environment");
    assert.equal(code(() => buildSecretRef({ provider: "aws-sm", platform: "awin" })), "provider_not_configured");
  });

  it("describes a reference without its target", () => {
    assert.deepEqual(describeSecretRef("aws-sm:mbo/production/networks/awin/default"), { provider: "aws-sm", configured: true });
    assert.deepEqual(describeSecretRef("mbo-sm://local-encrypted/network-account/1"), { provider: null, configured: false });
    assert.equal(isProviderSecretRef("env:awin"), true);
    assert.equal(parseSecretRef("env:awin").reference, "awin");
  });
});

describe("AWS Secrets Manager replaces or coexists with env without touching adapters", () => {
  it("registers alongside env and resolves only catalogued slot keys from the JSON secret", async () => {
    const requested = [];
    registerCredentialProvider(
      createAwsSecretsManagerProvider({
        fetchSecretString: async (id) => {
          requested.push(id);
          return JSON.stringify({ primarySecret: "aws-key", contactId: "9", extraneous: "ignored", DATABASE_URL: "x" });
        },
      }),
    );
    assert.deepEqual(registeredCredentialProviders().sort(), ["aws-sm", "env"]);
    const { values, provider } = await resolveCredentialSlots({
      platform: "optimise_sea",
      accountLabel: "default",
      environment: "PRODUCTION",
      secretRef: "aws-sm:mbo/production/networks/optimise_sea/default",
    });
    assert.equal(provider, "aws-sm");
    assert.deepEqual(values, { primarySecret: "aws-key", contactId: "9" });
    assert.deepEqual(requested, ["mbo/production/networks/optimise_sea/default"]);
  });

  it("a provider read failure carries no secret or provider text", async () => {
    registerCredentialProvider(
      createAwsSecretsManagerProvider({ fetchSecretString: async () => { throw new Error("AccessDenied for arn:...:secret-value"); } }),
    );
    await assert.rejects(
      resolveCredentialSlots({ platform: "awin", secretRef: "aws-sm:mbo/production/networks/awin/default" }),
      (error) => error.code === "provider_read_failed" && !/arn|secret-value/.test(error.message),
    );
  });

  it("only known provider names can be registered", () => {
    assert.throws(() => registerCredentialProvider({ name: "vault", referenceFor() {}, validateReference() {}, resolve() {} }), /known/);
    assert.throws(() => registerCredentialProvider({ name: "aws-sm" }), /missing/);
    assert.throws(() => createAwsSecretsManagerProvider({}), /fetchSecretString/);
  });

  it("supplier adapters and sync jobs never import a provider or read credential env names directly", () => {
    const files = [
      "src/modules/integrations/optimiseCredentials.js",
      "src/modules/integrations/boostinyCredentials.js",
      "src/modules/integrations/trackierCredentials.js",
      "src/modules/integrations/awinCredentials.js",
      "src/modules/integrations/partnerizeCredentials.js",
      "src/jobs/waveESupplierSync.js",
    ];
    const catalogued = Object.values(NETWORK_CREDENTIAL_CATALOG).flatMap((p) => Object.values(p.slots).map((s) => s.env));
    for (const file of files) {
      const code = readFileSync(file, "utf8");
      for (const name of catalogued) assert.ok(!code.includes(`process.env.${name}`), `${file}: process.env.${name}`);
      assert.ok(!/createAwsSecretsManagerProvider|createEnvCredentialProvider|registerCredentialProvider/.test(code), file);
    }
    for (const adapter of ["optimise", "boostiny", "trackier", "awin", "partnerize", "impact"]) {
      const code = readFileSync(`src/adapters/${adapter}.adapter.js`, "utf8");
      assert.ok(!code.includes("credentialResolver"), `${adapter} adapter depends on the resolver`);
    }
  });
});

describe("legacyEnvCredential — connection-less fallback through the env provider", () => {
  it("reads only the catalogued name for that platform and slot", async () => {
    const { source, asked } = recordingEnv({ AWIN_PUBLISHER_ID: " 123 ", AWIN_ACCESS_TOKEN: "t" });
    registerCredentialProvider(createEnvCredentialProvider({ envSource: source }));
    assert.equal(await legacyEnvCredential("awin", S.ACCOUNT_EXTERNAL_ID), "123");
    assert.equal(await legacyEnvCredential("awin", S.CONTACT_ID), null);
    assert.equal(await legacyEnvCredential("rakuten", S.PRIMARY_SECRET), null);
    assert.deepEqual(asked, ["AWIN_PUBLISHER_ID"]);
  });

  it("the provider names are the two known ones", () => {
    assert.deepEqual(Object.values(CREDENTIAL_PROVIDER_NAMES).sort(), ["aws-sm", "env"]);
  });
});
