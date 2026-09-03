#!/usr/bin/env node

/**
 * Read-only CJ GraphQL schema verifier.
 *
 * Required for Commission Detail:
 *   CJ_ACCESS_TOKEN
 *
 * Optional:
 *   CJ_COMMISSION_DETAIL_URL (defaults to documented https://commissions.api.cj.com/query)
 *   CJ_PROGRAM_TERMS_URL    (no default: do not guess an endpoint)
 *
 * This script prints schema field names/arguments only. It never prints the token
 * and does not request commission/order data.
 */

const token = process.env.CJ_ACCESS_TOKEN;
if (!token) {
  console.error("CJ_ACCESS_TOKEN is required.");
  process.exit(2);
}

const commissionDetailUrl =
  process.env.CJ_COMMISSION_DETAIL_URL || "https://commissions.api.cj.com/query";
const programTermsUrl = process.env.CJ_PROGRAM_TERMS_URL || null;

const INTROSPECTION_QUERY = `
  query MboCjSchemaCheck {
    __schema {
      queryType {
        name
        fields {
          name
          args {
            name
            type {
              kind
              name
              ofType {
                kind
                name
                ofType { kind name }
              }
            }
          }
        }
      }
    }
  }
`;

function typeName(type) {
  if (!type) return null;
  if (type.name) return type.name;
  if (type.kind === "NON_NULL") return `${typeName(type.ofType)}!`;
  if (type.kind === "LIST") return `[${typeName(type.ofType)}]`;
  return typeName(type.ofType) || type.kind || null;
}

async function inspect(label, url) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query: INTROSPECTION_QUERY }),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  const fields = payload?.data?.__schema?.queryType?.fields ?? [];
  const safe = {
    label,
    url,
    httpStatus: response.status,
    introspectionAvailable: fields.length > 0,
    queryType: payload?.data?.__schema?.queryType?.name ?? null,
    fields: fields.map((field) => ({
      name: field.name,
      args: (field.args ?? []).map((arg) => ({
        name: arg.name,
        type: typeName(arg.type),
      })),
    })),
    errorMessages: Array.isArray(payload?.errors)
      ? payload.errors.map((error) => String(error?.message || "GraphQL error").slice(0, 300))
      : [],
  };

  console.log(JSON.stringify(safe, null, 2));
  return safe;
}

let failed = false;

try {
  const result = await inspect("commission_detail", commissionDetailUrl);
  if (!result.introspectionAvailable) failed = true;
} catch (error) {
  failed = true;
  console.error(JSON.stringify({
    label: "commission_detail",
    url: commissionDetailUrl,
    error: String(error?.message || error).slice(0, 300),
  }, null, 2));
}

if (programTermsUrl) {
  try {
    const result = await inspect("program_terms", programTermsUrl);
    if (!result.introspectionAvailable) failed = true;
  } catch (error) {
    failed = true;
    console.error(JSON.stringify({
      label: "program_terms",
      url: programTermsUrl,
      error: String(error?.message || error).slice(0, 300),
    }, null, 2));
  }
} else {
  console.log(JSON.stringify({
    label: "program_terms",
    skipped: true,
    reason: "CJ_PROGRAM_TERMS_URL not set; endpoint intentionally not guessed.",
  }, null, 2));
}

process.exitCode = failed ? 1 : 0;
