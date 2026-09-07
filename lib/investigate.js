// ContractCritic — shared investigation logic
// Used by both the Vercel serverless adapter (api/analyze.js)
// and the local development server (server.js).
// No SDKs. Native fetch() only.

const MAX_SOURCE_BYTES = 120_000;
const GRAPH_INTROSPECTION_TIMEOUT_MS = 12000;
const GRAPH_QUERY_TIMEOUT_MS = 20000;
const GRAPH_REGISTRY_TIMEOUT_MS = 15000;

const TOP_SUBGRAPHS_FOR_STATISTICS = parseInt(
  process.env.TOP_SUBGRAPHS_FOR_STATISTICS || "3",
  10
);
const GRAPH_QUERY_MAX_ITEMS = parseInt(
  process.env.GRAPH_QUERY_MAX_ITEMS || "25",
  10
);
const GRAPH_NETWORK_URL = process.env.GRAPH_NETWORK_URL || "";

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
// 2. The Graph — registry discovery → introspection → record fetch
// ---------------------------------------------------------------------------

/**
 * discoverSubgraphs — query the Graph Network registry subgraph to find
 * subgraph deployments whose manifest dataSources include the target
 * contract address. Returns candidates sorted by queryFeesAmount desc,
 * limited to TOP_SUBGRAPHS_FOR_STATISTICS.
 */
async function discoverSubgraphs(address) {
  const registryUrl = process.env.GRAPH_NETWORK_URL;
  if (!registryUrl) return [];

  const lowerAddr = address.toLowerCase();

  // The Graph Network subgraph exposes Subgraph / SubgraphDeployment entities.
  // We search for subgraphs whose dataSources reference our contract address.
  // The registry schema stores source addresses as bytes; we filter client-side
  // because the registry's GraphQL API may not support direct address filtering.
  const query = `{
    subgraphs(first: 100, orderBy: currentVersion, orderDirection: desc) {
      id
      displayName
      currentVersion {
        subgraphDeployment {
          id
          ipfsHash
          denominatedNetwork
          signalledTokens
          queryFeesAmount
          manifest {
            dataSources {
              name
              source {
                address
                startBlock
                abi
              }
            }
          }
        }
      }
    }
  }`;

  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  const graphKey = process.env.GRAPH_API_KEY;
  if (graphKey) headers.Authorization = `Bearer ${graphKey}`;

  let resp;
  try {
    resp = await fetchWithTimeout(
      registryUrl,
      { method: "POST", headers, body: JSON.stringify({ query }) },
      GRAPH_REGISTRY_TIMEOUT_MS
    );
  } catch {
    return [];
  }

  if (!resp.ok) return [];

  const body = await resp.json().catch(() => null);
  if (!body || !body.data || !body.data.subgraphs) return [];

  // Filter: only subgraphs whose dataSources reference our contract address
  const matched = [];
  for (const sg of body.data.subgraphs) {
    const versions = sg.currentVersion;
    // currentVersion can be an object or array depending on registry schema
    const versionList = Array.isArray(versions) ? versions : [versions];
    for (const ver of versionList) {
      if (!ver || !ver.subgraphDeployment) continue;
      const dep = ver.subgraphDeployment;
      const dataSources = dep.manifest?.dataSources || [];
      let addressMatch = false;
      for (const ds of dataSources) {
        const dsAddr = ds?.source?.address;
        if (!dsAddr) continue;
        if (dsAddr.toLowerCase() === lowerAddr) {
          addressMatch = true;
          break;
        }
      }
      if (addressMatch) {
        matched.push({
          subgraph: {
            id: sg.id,
            name: sg.displayName || sg.id,
            network: dep.denominatedNetwork || "mainnet",
          },
          deploymentId: dep.id,
          ipfsHash: dep.ipfsHash,
          queryFeesAmount: BigInt(dep.queryFeesAmount || "0"),
          signalledTokens: BigInt(dep.signalledTokens || "0"),
        });
      }
    }
  }

  // Sort by queryFeesAmount desc, take top N
  matched.sort((a, b) => {
    if (b.queryFeesAmount > a.queryFeesAmount) return 1;
    if (b.queryFeesAmount < a.queryFeesAmount) return -1;
    return 0;
  });

  return matched.slice(0, TOP_SUBGRAPHS_FOR_STATISTICS);
}

/**
 * buildGatewayUrl — construct the query gateway URL for a specific subgraph deployment.
 */
function buildGatewayUrl(deploymentId) {
  const graphKey = process.env.GRAPH_API_KEY || "";
  return `https://gateway.thegraph.com/api/${graphKey}/subgraphs/id/${deploymentId}`;
}

/**
 * introspectSchema — query the subgraph's GraphQL schema to discover ALL
 * entity types and ALL their scalar fields. No limits, no slicing.
 */
async function introspectSchema(gatewayUrl, headers) {
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
            ofType { name kind ofType { name kind ofType { name kind } } }
          }
        }
      }
    }
  }`;

  const resp = await fetchWithTimeout(
    gatewayUrl,
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
  const queryTypeName = body.data.__schema?.queryType?.name;
  const queryType = schemaTypes.find((t) => t.name === queryTypeName);

  if (!queryType || !queryType.fields) {
    return { deploymentId, entities: [] };
  }

  // Entity fields are root query fields that return lists
  const entityFields = queryType.fields.filter((f) => {
    if (f.name.startsWith("_")) return false;
    // Unwrap type to check if it's a list
    let t = f.type;
    while (t) {
      if (t.kind === "LIST") return true;
      t = t.ofType;
    }
    return false;
  });

  const entities = entityFields.map((f) => {
    // Unwrap to get the object type name
    let typeName = f.type?.name;
    let t = f.type;
    while (t?.ofType) {
      if (t.ofType.name) {
        typeName = t.ofType.name;
        break;
      }
      t = t.ofType;
    }
    return {
      queryName: f.name,
      typeName: typeName || f.name,
    };
  });

  // For each entity, find ALL its scalar fields — no limits
  const entitiesWithFields = entities
    .map((e) => {
      const typeDef = schemaTypes.find((t) => t.name === e.typeName);
      if (!typeDef || !typeDef.fields) return null;
      const scalarFields = typeDef.fields
        .filter((f) => {
          const ft = f.type;
          const baseType = ft?.name || ft?.ofType?.name || ft?.ofType?.ofType?.name || ft?.ofType?.ofType?.ofType?.name;
          return (
            baseType &&
            [
              "ID", "String", "Int", "Int8", "BigInt",
              "BigDecimal", "Boolean", "Bytes", "Timestamp",
            ].includes(baseType) &&
            !f.name.startsWith("_")
          );
        })
        .map((f) => f.name);
      if (scalarFields.length === 0) return null;
      return { ...e, fields: scalarFields };
    })
    .filter(Boolean);

  return { deploymentId, entities: entitiesWithFields };
}

/**
 * buildEntityQuery — build a GraphQL query for a single entity with ALL its fields.
 * Tries ordering by timestamp; falls back to no ordering if the entity lacks that field.
 */
function buildEntityQuery(entity, withOrderBy) {
  const fieldList = entity.fields.join("\n      ");
  const args = withOrderBy
    ? `first: ${GRAPH_QUERY_MAX_ITEMS}, orderBy: timestamp, orderDirection: desc`
    : `first: ${GRAPH_QUERY_MAX_ITEMS}`;
  return `{
    ${entity.queryName}(${args}) {
      ${fieldList}
    }
  }`;
}

/**
 * fetchRecords — query the subgraph for records of each entity.
 * Returns { [entityName]: object[] }.
 */
async function fetchRecords(gatewayUrl, headers, schema) {
  const records = {};

  // Query entities in parallel
  const promises = schema.entities.map(async (entity) => {
    // Try with orderBy: timestamp first; fall back to no ordering on error
    for (const withOrderBy of [true, false]) {
      const query = buildEntityQuery(entity, withOrderBy);
      try {
        const resp = await fetchWithTimeout(
          gatewayUrl,
          { method: "POST", headers, body: JSON.stringify({ query }) },
          GRAPH_QUERY_TIMEOUT_MS
        );
        if (!resp.ok) {
          if (withOrderBy) continue;
          records[entity.queryName] = [];
          return;
        }
        const body = await resp.json();
        if (body.errors && body.errors.length > 0) {
          if (withOrderBy) continue;
          records[entity.queryName] = [];
          return;
        }
        records[entity.queryName] = (body.data && body.data[entity.queryName]) || [];
        return;
      } catch {
        if (withOrderBy) continue;
        records[entity.queryName] = [];
        return;
      }
    }
    records[entity.queryName] = [];
  });

  await Promise.all(promises);
  return records;
}

/**
 * fetchGraphData — orchestrates the full Graph flow:
 *   1. discoverSubgraphs (registry, address-match, sort by queryFeesAmount)
 *   2. For each candidate in parallel: introspectSchema + fetchRecords
 *   3. Build the graphData object with sources[]
 */
export async function fetchGraphData(address) {
  // Step 1: Discover candidate subgraphs from the registry
  let candidates;
  try {
    candidates = await discoverSubgraphs(address);
  } catch {
    candidates = [];
  }

  if (candidates.length === 0) {
    return { available: false, reason: "No suitable Subgraph available for this contract" };
  }

  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  const graphKey = process.env.GRAPH_API_KEY;
  if (graphKey) headers.Authorization = `Bearer ${graphKey}`;

  // Step 2: For each candidate, introspect schema + fetch records in parallel
  const sourceResults = await Promise.all(
    candidates.map(async (candidate) => {
      const gatewayUrl = buildGatewayUrl(candidate.deploymentId);

      // Introspect schema
      let schema;
      try {
        schema = await introspectSchema(gatewayUrl, headers);
      } catch {
        return null; // skip this source
      }

      if (!schema || schema.entities.length === 0) return null;

      // Fetch records for all entities
      let records;
      try {
        records = await fetchRecords(gatewayUrl, headers, schema);
      } catch {
        records = {};
      }

      // Build fields map: { [entity]: string[] }
      const fields = {};
      for (const entity of schema.entities) {
        fields[entity.queryName] = entity.fields;
      }

      // Build records map: { [entity]: object[] }
      const entityRecords = {};
      for (const entity of schema.entities) {
        entityRecords[entity.queryName] = records[entity.queryName] || [];
      }

      return {
        subgraph: candidate.subgraph,
        queryFeesAmount: Number(candidate.queryFeesAmount),
        signalledTokens: Number(candidate.signalledTokens),
        fields,
        records: entityRecords,
      };
    })
  );

  // Filter out failed sources
  const sources = sourceResults.filter((s) => s !== null);

  if (sources.length === 0) {
    return { available: false, reason: "No suitable Subgraph available for this contract" };
  }

  return {
    available: true,
    sourcesCount: sources.length,
    sources,
  };
}

// ---------------------------------------------------------------------------
// 3. Build the Graph section for the AI prompt
// ---------------------------------------------------------------------------

function buildGraphSection(graph) {
  if (!graph.available) {
    return `THE GRAPH — LIVE INDEXED DATA:
No suitable Subgraph was available for this contract. Graph evidence is unavailable.
The investigation continues with source-code evidence only.`;
  }

  const lines = [
    "THE GRAPH — LIVE INDEXED DATA (this is real on-chain evidence, not simulated):",
    "",
  ];

  for (const src of graph.sources) {
    lines.push(
      `Источник: ${src.subgraph.name} (queryFeesAmount: ${src.queryFeesAmount}, signalledTokens: ${src.signalledTokens})`
    );
    lines.push("");

    for (const [entityName, fieldList] of Object.entries(src.fields)) {
      lines.push(`  ${entityName}:`);

      const entityRecords = src.records[entityName] || [];

      if (entityRecords.length === 0) {
        // No records — still list all fields with (нет данных)
        for (const field of fieldList) {
          lines.push(`    ${field}: (нет данных)`);
        }
      } else {
        // Show each record with all fields
        for (const record of entityRecords) {
          for (const field of fieldList) {
            const val = record[field];
            if (val !== null && val !== undefined) {
              lines.push(`    ${field}: ${val}`);
            } else {
              lines.push(`    ${field}: (нет данных)`);
            }
          }
          lines.push("    ---");
        }
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 4. AI — Cloudflare Workers AI
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
  const graphSection = buildGraphSection(graph);

  return `You are ContractCritic, an investigative smart-contract analyst.

THE GRAPH IS YOUR PRIMARY ON-CHAIN EVIDENCE SOURCE.
- The Graph data tells you what has ACTUALLY happened on-chain (observed activity, real transactions, real metrics).
- The ABI and source code tell you what the contract CAN do (its capabilities).
- The Graph does NOT override conclusions drawn from the code. If code shows a risk, that risk exists regardless of whether Graph data shows activity.
- If The Graph data and the source code appear to contradict each other, flag the discrepancy explicitly.
- NEVER invent numbers, addresses, or records that do not appear in the Graph data below.
- If a field shows "(нет данных)", that means no data was available — do not speculate about what it might contain.

Distinguish FACT from INTERPRETATION and UNKNOWN:
- FACT: directly supported by source code, ABI, or Graph data.
- INTERPRETATION: reasoning based on one or more facts.
- UNKNOWN: information that cannot be established from the available data.

When The Graph data shows activity related to a privileged mechanism found in the source code, connect those facts explicitly. For example:
- FACT (source code): The contract contains an admin role capable of changing critical parameters.
- FACT (The Graph): Graph data shows repeated activity associated with the privileged mechanism.
- INTERPRETATION: The administrative control is not merely theoretical — it has been actively used.

Distinguish in your reasoning:
1. Facts from source code
2. Facts from The Graph
3. Interpretations combining both
4. Unknown information

Never invent functions, addresses, transactions, events, balances, permissions, or Graph data.
If evidence is unavailable, say so.
Do not call something an exploit merely because a function exists.
Explain realistic consequences.
Pay particular attention to who controls the contract and what privileged actors can change.
Compare apparent decentralization or immutability claims against actual implementation.

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
        {
          role: "system",
          content:
            "You are ContractCritic. The Graph is your primary on-chain evidence source. Return only valid JSON.",
        },
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
// 5. Main investigation orchestrator
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
