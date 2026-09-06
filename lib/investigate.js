// ContractCritic — shared investigation logic
// Used by both the Vercel serverless adapter (api/analyze.js)
// and the local development server (server.js).
// No SDKs. Native fetch() only.

const MAX_SOURCE_BYTES = 120_000;
const MAX_GRAPH_ENTITIES = 40;
const GRAPH_INTROSPECTION_TIMEOUT_MS = 8000;
const GRAPH_QUERY_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isValidAddress(addr) {
  return typeof addr === "string" && /^0x[a-fA-F0-9]{40}$/.test(addr);
}

function safeStr(v, fallback = "") {
  return typeof v === "string" ? v : fallback;
}

function truncate(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n/* … source truncated for length … */";
}

function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

// ---------------------------------------------------------------------------
// 1. Explorer — verified source + ABI
// ---------------------------------------------------------------------------

export async function fetchExplorerData(address) {
  const apiKey = process.env.EXPLORER_API_KEY || "";
  const baseUrl = process.env.EXPLORER_API_URL || "https://api.etherscan.io/api";

  const params = new URLSearchParams({
    module: "contract",
    action: "getsourcecode",
    address,
    apikey: apiKey,
  });

  const url = `${baseUrl}?${params.toString()}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Explorer HTTP ${res.status}`);
  const data = await res.json();

  if (data.status === "0" || !Array.isArray(data.result) || data.result.length === 0) {
    throw new Error("Explorer returned no data for this address");
  }

  const item = data.result[0];

  const sourceCode = safeStr(item.SourceCode);
  const abiRaw = safeStr(item.ABI);
  const contractName = safeStr(item.ContractName, "Unknown");
  const compilerVersion = safeStr(item.CompilerVersion);
  const optimizationUsed = safeStr(item.OptimizationUsed);
  const runs = safeStr(item.Runs);
  const proxy = safeStr(item.Proxy) === "1";
  const implementation = safeStr(item.Implementation);
  const swarmSource = safeStr(item.SwarmSource);

  let abi = [];
  try {
    abi = abiRaw && abiRaw !== "Contract source code not verified" ? JSON.parse(abiRaw) : [];
  } catch {
    try {
      abi = JSON.parse(abiRaw.replace(/^\{|\}$/g, ""));
    } catch {
      abi = [];
    }
  }

  // Handle multi-file source bundles (Etherscan returns JSON object when multiple files)
  let sourceText = sourceCode;
  let sourceFiles = [];
  if (sourceCode.startsWith("{")) {
    try {
      const parsed = JSON.parse(sourceCode);
      if (parsed.sources) {
        sourceFiles = Object.entries(parsed.sources).map(([path, info]) => ({
          path,
          content: safeStr(info.content),
        }));
        sourceText = sourceFiles
          .map((f) => `// File: ${f.path}\n${f.content}`)
          .join("\n\n");
      } else {
        sourceText = sourceCode;
      }
    } catch {
      sourceText = sourceCode;
    }
  }

  const verified = sourceCode.length > 0 && abiRaw !== "Contract source code not verified";

  return {
    verified,
    contractName,
    compilerVersion,
    optimizationUsed,
    runs,
    proxy,
    implementation,
    abi,
    sourceText,
    sourceFiles,
    swarmSource,
  };
}

// ---------------------------------------------------------------------------
// 2. The Graph — schema-aware discovery + query
// ---------------------------------------------------------------------------

export async function fetchGraphData(address) {
  const graphUrl = process.env.GRAPH_API_URL;
  const graphKey = process.env.GRAPH_API_KEY;

  if (!graphUrl) {
    return { available: false, reason: "GRAPH_API_URL not configured" };
  }

  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (graphKey) headers.Authorization = `Bearer ${graphKey}`;

  // Step 1: Introspect the subgraph schema to discover available entity types
  let schema;
  try {
    schema = await introspectSchema(graphUrl, headers);
  } catch (e) {
    return { available: false, reason: `Schema introspection failed: ${e.message}` };
  }

  if (!schema || schema.entities.length === 0) {
    return { available: false, reason: "No suitable Subgraph available for this contract" };
  }

  // Step 2: Build a query using only entities that actually exist in this subgraph
  const query = buildSchemaAwareQuery(schema, address);
  if (!query) {
    return { available: false, reason: "No queryable entities found in this Subgraph" };
  }

  // Step 3: Execute the query
  let resp;
  try {
    resp = await fetchWithTimeout(
      graphUrl,
      { method: "POST", headers, body: JSON.stringify({ query }) },
      GRAPH_QUERY_TIMEOUT_MS
    );
  } catch (e) {
    return { available: false, reason: `Graph query failed: ${e.message}` };
  }

  if (!resp.ok) {
    return { available: false, reason: `Graph HTTP ${resp.status}` };
  }

  const body = await resp.json();

  if (body.errors && body.errors.length > 0) {
    return {
      available: false,
      reason: `Graph errors: ${body.errors.map((e) => e.message).join("; ")}`,
    };
  }

  if (!body.data) {
    return { available: false, reason: "No data returned from Subgraph" };
  }

  return normalizeGraphData(body.data, schema, address);
}

// Introspect the subgraph's GraphQL schema to discover what entities exist
async function introspectSchema(graphUrl, headers) {
  const introspectionQuery = `{
    _meta { deployment { id } }
    __schema {
      queryType { name }
      types {
        name
        kind
        fields {
          name
          type {
            name
            kind
            ofType { name kind ofType { name kind } }
          }
        }
      }
    }
  }`;

  const resp = await fetchWithTimeout(
    graphUrl,
    { method: "POST", headers, body: JSON.stringify({ query: introspectionQuery }) },
    GRAPH_INTROSPECTION_TIMEOUT_MS
  );

  if (!resp.ok) throw new Error(`Introspection HTTP ${resp.status}`);

  const body = await resp.json();

  if (body.errors && body.errors.length > 0) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }

  if (!body.data) throw new Error("No data from introspection");

  const deploymentId = body.data._meta?.deployment?.id || "unknown";
  const schemaTypes = body.data.__schema?.types || [];

  // Extract entity types — in subgraphs, these are the types with a `first` argument
  // on their root query field. We look at the Query type's fields.
  const queryType = schemaTypes.find((t) => t.name === body.data.__schema?.queryType?.name);

  if (!queryType || !queryType.fields) {
    return { deploymentId, entities: [] };
  }

  // Entity names are root-level query fields that return lists (have first/skip/orderBy args)
  // We filter out underscore-prefixed fields like _meta and __schema
  const entityFields = queryType.fields.filter(
    (f) =>
      !f.name.startsWith("_") &&
      f.name !== "meta" &&
      // Entity list fields typically have these arguments
      // We can't see args in standard introspection, but entity fields return list types
      (f.type?.kind === "NON_NULL" || f.type?.kind === "LIST" ||
       f.type?.ofType?.kind === "LIST" || f.type?.ofType?.ofType?.kind === "LIST")
  );

  const entities = entityFields.map((f) => {
    // Unwrap the type to get the entity name
    let typeName = f.type?.name;
    if (!typeName) {
      // Unwrap NON_NULL → LIST → OBJECT
      let t = f.type;
      while (t?.ofType) {
        if (t.ofType.name) {
          typeName = t.ofType.name;
          break;
        }
        t = t.ofType;
      }
    }
    return {
      queryName: f.name,
      typeName: typeName || f.name,
    };
  });

  // For each entity, find its scalar fields from the schema types
  const entitiesWithFields = entities
    .map((e) => {
      const typeDef = schemaTypes.find((t) => t.name === e.typeName);
      if (!typeDef || !typeDef.fields) return null;
      const scalarFields = typeDef.fields
        .filter((f) => {
          const ft = f.type;
          const baseType = ft?.name || ft?.ofType?.name || ft?.ofType?.ofType?.name;
          return (
            baseType &&
            ["ID", "String", "Int", "Int8", "BigInt", "BigDecimal", "Boolean", "Bytes", "Timestamp"].includes(
              baseType
            ) &&
            !f.name.startsWith("_")
          );
        })
        .map((f) => f.name)
        .slice(0, 12);
      if (scalarFields.length === 0) return null;
      return { ...e, fields: scalarFields };
    })
    .filter(Boolean);

  return { deploymentId, entities: entitiesWithFields };
}

// Build a query using only entities and fields that actually exist in the schema
function buildSchemaAwareQuery(schema, address) {
  if (!schema.entities || schema.entities.length === 0) return null;

  // Prioritize entities likely to contain relevant activity
  // Look for common patterns: transactions, transfers, events, swaps, etc.
  const priorityKeywords = [
    "transaction",
    "transfer",
    "event",
    "swap",
    "deposit",
    "withdraw",
    "mint",
    "burn",
    "claim",
    "stake",
    "financials",
    "usage",
    "protocol",
    "revenue",
    "dailySnapshot",
    "hourlySnapshot",
  ];

  const sorted = [...schema.entities].sort((a, b) => {
    const aScore = priorityKeywords.reduce(
      (s, kw) => s + (a.queryName.toLowerCase().includes(kw) ? 1 : 0),
      0
    );
    const bScore = priorityKeywords.reduce(
      (s, kw) => s + (b.queryName.toLowerCase().includes(kw) ? 1 : 0),
      0
    );
    return bScore - aScore;
  });

  // Query up to 6 entities, limited to recent records
  const selected = sorted.slice(0, 6);

  const fragments = selected.map((e) => {
    const fields = e.fields.slice(0, 8).join("\n      ");
    return `    ${e.queryName}(first: 10, orderBy: timestamp, orderDirection: desc) {
      ${fields}
    }`;
  });

  return `{
    _meta { deployment { id } }
${fragments.join("\n")}
  }`;
}

function normalizeGraphData(data, schema, address) {
  const normalized = {
    source: "The Graph",
    chain: "ethereum",
    subgraph: schema.deploymentId || data._meta?.deployment?.id || "unknown",
    entities: [],
    statistics: {},
    recentActivity: [],
  };

  for (const entity of schema.entities) {
    const records = data[entity.queryName];
    if (!Array.isArray(records) || records.length === 0) continue;

    normalized.entities.push(entity.queryName);

    // Check if this looks like a snapshot/metrics entity
    const nameLower = entity.queryName.toLowerCase();
    const first = records[0];
    const fields = Object.keys(first);

    if (
      nameLower.includes("snapshot") ||
      nameLower.includes("daily") ||
      nameLower.includes("hourly") ||
      nameLower.includes("financial") ||
      nameLower.includes("metric")
    ) {
      // Treat as statistics
      for (const field of fields) {
        const val = first[field];
        if (val !== null && val !== undefined) {
          normalized.statistics[`${entity.queryName}.${field}`] = val;
        }
      }
    } else {
      // Treat as activity records
      for (const record of records.slice(0, MAX_GRAPH_ENTITIES)) {
        const activity = { entityType: entity.queryName };
        for (const field of fields) {
          const val = record[field];
          if (val !== null && val !== undefined) {
            activity[field] = val;
          }
        }
        normalized.recentActivity.push(activity);
      }
    }
  }

  if (normalized.entities.length === 0 && normalized.recentActivity.length === 0) {
    return { available: false, reason: "No suitable Subgraph available for this contract" };
  }

  return { available: true, data: normalized };
}

// ---------------------------------------------------------------------------
// 3. AI — Cloudflare Workers AI
// ---------------------------------------------------------------------------

export function buildPrompt(explorer, graph, address) {
  const abiFunctions = (explorer.abi || [])
    .filter((e) => e.type === "function")
    .map((f) => `${f.name}(${(f.inputs || []).map((i) => i.type).join(",")})`)
    .slice(0, 80);

  const abiEvents = (explorer.abi || [])
    .filter((e) => e.type === "event")
    .map((e) => `${e.name}(${(e.inputs || []).map((i) => i.type).join(",")})`)
    .slice(0, 40);

  const sourceExcerpt = truncate(explorer.sourceText, MAX_SOURCE_BYTES);

  const graphSection = graph.available
    ? `THE GRAPH — LIVE INDEXED DATA (this is real on-chain evidence, not simulated):
Subgraph deployment: ${graph.data.subgraph || "unknown"}
Chain: ${graph.data.chain || "ethereum"}
Entities found: ${graph.data.entities.join(", ")}

Statistics:
${JSON.stringify(graph.data.statistics, null, 2)}

Recent activity:
${JSON.stringify(graph.data.recentActivity, null, 2)}`
    : `THE GRAPH — LIVE INDEXED DATA:
No suitable Subgraph was available for this contract. Graph evidence is unavailable.
The investigation continues with source-code evidence only.`;

  return `You are ContractCritic, an investigative smart-contract analyst.

Your job is not to blindly trust the project. Analyze the verified source code, ABI, and live blockchain evidence below.

Distinguish FACT from INTERPRETATION and UNKNOWN:
- FACT: directly supported by source code, ABI, or Graph data.
- INTERPRETATION: reasoning based on one or more facts.
- UNKNOWN: information that cannot be established from the available data.

Never invent functions, addresses, transactions, events, balances, permissions, or Graph data.
If evidence is unavailable, say so.
Do not call something an exploit merely because a function exists.
Explain realistic consequences.
Pay particular attention to who controls the contract and what privileged actors can change.
Compare apparent decentralization or immutability claims against actual implementation.
Use The Graph evidence when available. The Graph data is live evidence and must be considered in your reasoning.

When The Graph data shows activity related to a privileged mechanism found in the source code, connect those facts explicitly. For example:
- FACT (source code): The contract contains an admin role capable of changing critical parameters.
- FACT (The Graph): Graph data shows repeated activity associated with the privileged mechanism.
- INTERPRETATION: The administrative control is not merely theoretical — it has been actively used.

Distinguish in your reasoning:
1. Facts from source code
2. Facts from The Graph
3. Interpretations combining both
4. Unknown information

Investigate, when applicable:
- Ownership (owner, ownership transfer, renounce ownership, multiple ownership mechanisms)
- Access control (Ownable, AccessControl, DEFAULT_ADMIN_ROLE, custom roles, privileged addresses, role administration)
- Upgradeability (proxy, implementation, UUPS, Transparent Proxy, Beacon Proxy, upgrade functions)
- Emergency controls (pause, unpause, emergency withdrawal, emergency admin, freeze mechanisms)
- Token controls (mint, burn, blacklist, whitelist, transfer restrictions, supply changes)
- Fees (buy fees, sell fees, transfer fees, configurable fees, maximum fee limits)
- Governance (governance contract, multisig, timelock, voting, admin-controlled governance)
- External dependencies (oracles, external contracts, routers, bridges, callbacks, price feeds)
- User/fund risks (privileged fund withdrawal, arbitrary parameter changes, token supply manipulation, transfer blocking, upgrade to malicious implementation, centralized emergency controls, oracle manipulation, dependency failure)

Keep the tone that of a sharp, dry, investigative technical critic. Subtle dry humor is welcome. Do not be sensational.

Return ONLY valid JSON (no markdown fences, no commentary before or after) matching this schema exactly:
{
  "executiveSummary": "string",
  "riskLevel": "LOW CONCERN" | "MODERATE CONCERN" | "HIGH CONCERN" | "VERY HIGH CONCERN",
  "whatItDoes": "string",
  "whoControlsIt": "string",
  "decentralization": "string",
  "technicalMechanisms": [ { "title": "string", "severity": "string", "type": "FACT|INTERPRETATION|UNKNOWN", "evidence": "string", "analysis": "string" } ],
  "whatCouldGoWrong": [ { "title": "string", "severity": "string", "type": "FACT|INTERPRETATION|UNKNOWN", "evidence": "string", "analysis": "string" } ],
  "onChainEvidence": [ { "title": "string", "severity": "string", "type": "FACT|INTERPRETATION|UNKNOWN", "evidence": "string", "analysis": "string" } ],
  "marketingVsReality": [ { "title": "string", "severity": "string", "type": "FACT|INTERPRETATION|UNKNOWN", "evidence": "string", "analysis": "string" } ],
  "positiveSignals": [ { "title": "string", "severity": "string", "type": "FACT|INTERPRETATION|UNKNOWN", "evidence": "string", "analysis": "string" } ],
  "keyFindings": [ { "title": "string", "severity": "string", "type": "FACT|INTERPRETATION|UNKNOWN", "evidence": "string", "analysis": "string" } ],
  "finalVerdict": "string",
  "bottomLine": "string"
}

If you cannot determine something, use UNKNOWN. If no marketing claims were supplied, say so in marketingVsReality.

---
CONTRACT ADDRESS: ${address}
CONTRACT NAME: ${explorer.contractName}
COMPILER: ${explorer.compilerVersion}
PROXY: ${explorer.proxy}
IMPLEMENTATION: ${explorer.implementation || "n/a"}
VERIFIED: ${explorer.verified}

ABI FUNCTIONS (${abiFunctions.length}):
${abiFunctions.join("\n")}

ABI EVENTS (${abiEvents.length}):
${abiEvents.join("\n")}

VERIFIED SOURCE CODE:
${sourceExcerpt}

${graphSection}
`;
}

export async function callAI(prompt) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const model = process.env.CLOUDFLARE_AI_MODEL || "@cf/google/gemma-4-26b-a4b-it";

  if (!accountId || !apiToken) {
    throw new Error("Cloudflare AI credentials not configured");
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages: [
        { role: "system", content: "You are ContractCritic. Return only valid JSON." },
        { role: "user", content: prompt },
      ],
      max_tokens: 2048,
      temperature: 0.4,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let reason = `Cloudflare AI HTTP ${resp.status}`;
    if (resp.status === 429) reason = "AI free daily limit exhausted. Please try again later.";
    throw new Error(`${reason}${text ? ` — ${text.slice(0, 200)}` : ""}`);
  }

  const body = await resp.json();

  if (!body.success && body.errors) {
    throw new Error(
      `Cloudflare AI error: ${(body.errors || []).map((e) => e.message || JSON.stringify(e)).join("; ")}`
    );
  }

  const text = body.result?.response || body.result || "";
  if (!text) throw new Error("AI returned empty response");

  return parseAIJson(text);
}

function parseAIJson(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  }

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("AI response did not contain valid JSON");
  }

  const jsonStr = cleaned.slice(start, end + 1);

  try {
    return JSON.parse(jsonStr);
  } catch {
    try {
      const fixed = jsonStr.replace(/,\s*([}\]])/g, "$1");
      return JSON.parse(fixed);
    } catch {
      throw new Error("AI returned malformed JSON that could not be recovered");
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Main investigation orchestrator
// ---------------------------------------------------------------------------

export async function investigate(address) {
  // 1. Validate
  if (!isValidAddress(address)) {
    return {
      status: 400,
      body: { success: false, error: "Enter a valid Ethereum contract address." },
    };
  }

  // 2. Explorer
  let explorer;
  try {
    explorer = await fetchExplorerData(address);
  } catch (e) {
    return {
      status: 502,
      body: {
        success: false,
        error: "We couldn't retrieve verified contract data.",
        detail: e.message,
      },
    };
  }

  if (!explorer.verified) {
    return {
      status: 200,
      body: {
        success: false,
        error:
          "This contract does not have verified source code. ContractCritic cannot perform a reliable code-level investigation.",
        address,
        contract: { name: explorer.contractName, verified: false, proxy: explorer.proxy },
      },
    };
  }

  // 3. Graph (non-blocking — failure doesn't kill the investigation)
  let graph;
  try {
    graph = await fetchGraphData(address);
  } catch (e) {
    graph = { available: false, reason: `Graph error: ${e.message}` };
  }

  // 4. AI
  const prompt = buildPrompt(explorer, graph, address);

  let report;
  try {
    report = await callAI(prompt);
  } catch (e) {
    return {
      status: 502,
      body: {
        success: false,
        error: "The AI investigation failed. Please try again.",
        detail: e.message,
        address,
        contract: {
          name: explorer.contractName,
          verified: true,
          proxy: explorer.proxy,
        },
        graph,
      },
    };
  }

  return {
    status: 200,
    body: {
      success: true,
      address,
      contract: {
        name: explorer.contractName,
        verified: true,
        proxy: explorer.proxy,
        implementation: explorer.implementation || null,
        compiler: explorer.compilerVersion,
      },
      graph,
      report,
    },
  };
}
