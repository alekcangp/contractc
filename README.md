# ContractCritic

**Don't trust the contract. Interrogate it.**

AI investigative critic for smart contracts. Paste an Ethereum contract address — ContractCritic pulls verified source code, live indexed data from The Graph, and produces an evidence-based critical report.

> The contract says "trust me." We read the fine print.

---

## What is ContractCritic?

ContractCritic is an AI-powered investigative analyst for Ethereum smart contracts. It is **not** a formal security auditor and **not** just a vulnerability scanner. It reads the actual source code, examines on-chain evidence, and tells you what the contract *really* allows — who controls it, what can go wrong, and whether the reality matches the claims.

The user experience is deliberately simple:

```
Paste address → Investigate → Read report
```

No registration. No wallet connection. No API keys in the UI. No database.

---

## Architecture

```
Contract address
      ↓
Explorer API (verified source + ABI)
      ↓
The Graph Network registry → discover subgraphs by address match
      ↓
Per subgraph: schema introspection (all fields) → record fetch (≤ GRAPH_QUERY_MAX_ITEMS)
      ↓
Cloudflare Workers AI (investigation over source + Graph evidence)
      ↓
Structured JSON report
```

### Why this stack

- **Vanilla JS frontend** — zero build step, zero dependencies, zero framework lock-in
- **One serverless function** — Vercel adapter delegates to shared investigation logic
- **Shared logic** — `lib/investigate.js` used by both Vercel and local dev server
- **Native `fetch()`** — no SDKs anywhere in the stack
- **Stateless** — every investigation runs from scratch, no database needed

### Project structure

```
contractcritic/
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── api/
│   └── analyze.js          # Vercel serverless adapter
├── lib/
│   └── investigate.js      # Shared investigation logic
├── server.js                # Local dev server (zero dependencies)
├── package.json
├── vercel.json
├── .env.example
└── README.md
```

---

## The Graph integration

The Graph is the **primary on-chain evidence source** for ContractCritic — not decorative.

```
Source code = capabilities (what the contract CAN do)
The Graph = observed activity (what has actually happened on-chain)
AI = reasoning over both
```

### Flow

```
адрес контракта
  → discoverSubgraphs: Graph Network registry (GRAPH_NETWORK_URL)
      кандидаты ТОЛЬКО адрес-матч (адрес контракта в манифесте подграфа)
      → sort by queryFeesAmount desc → топ-N (TOP_SUBGRAPHS_FOR_STATISTICS, default 3)
  → для каждого источника параллельно:
      introspectSchema — ВСЕ скалярные поля каждой сущности (без лимитов)
      fetchRecords — записи каждой сущности (first: GRAPH_QUERY_MAX_ITEMS)
  → normalizeGraphData → graphSection → buildPrompt → callAI
```

### Principles

1. **No scoring.** No weights, thresholds, name heuristics, or synthetic confidence. The only filter is address-match; the only sort is by `queryFeesAmount`. The LLM assesses source reliability itself from the raw `queryFeesAmount` and `signalledTokens` (GRT) metrics — passed as numbers, as-is.

2. **All fields.** Schema introspection returns every scalar field of every entity — no `.slice()`, no limits.

3. **Completeness in the prompt.** Every entity from introspection appears in the Graph section with ALL its fields. Values come from records if available; otherwise the field is explicitly marked `(нет данных)`. The LLM never has to guess where data is missing.

4. **Section format** (line-by-line, no JSON.stringify, no process metrics):

```
Источник: <name> (queryFeesAmount: N, signalledTokens: N)

  Entity:
    field: value
    field: (нет данных)
```

5. **LLM rules** (in system message and prompt): The Graph is the primary on-chain source (what actually happened); ABI/code is the contract's capabilities; Graph does not override code conclusions; on discrepancy, flag it; never invent numbers not present in records.

### Data model

```js
graphData = {
  available: boolean,
  sourcesCount: number,
  sources: [{
    subgraph: { id, name, network },
    queryFeesAmount: number,   // raw relevance metric
    signalledTokens: number,   // GRT, raw
    fields:  { [entity]: string[] },  // ALL fields — always present
    records: { [entity]: object[] },  // ≤ GRAPH_QUERY_MAX_ITEMS; may be empty
  }],
}
```

- `fields` = schema (completeness guarantee), `records` = facts. Different obligations, not duplicates.
- Registry or subgraph unavailable → source is skipped; all unavailable → `available: false`, analysis continues without Graph.
- Registry endpoint is the current decentralized one (hosted `api.thegraph.com` is dead), overridable via env.

### How the AI uses Graph evidence

The AI is explicitly instructed to:

- Treat The Graph as primary on-chain evidence (what actually happened on-chain)
- Treat ABI/source code as the contract's capabilities (what it CAN do)
- Not let Graph data override code-based conclusions
- Flag discrepancies between code and Graph data
- Never invent numbers not present in the records
- Distinguish facts from source code vs. facts from The Graph
- Connect code capabilities with observed on-chain activity

### Honest handling when no subgraph is available

If no suitable subgraph exists, or if all Graph requests fail, the report clearly states:

```
The Graph: No suitable Subgraph was available for this contract.
```

The investigation continues with source-code evidence only. No fake green checkmark is shown.

---

## Local Development

### Prerequisites

- Node.js 18+ (for native `fetch()` and ES module support)

### Setup

```bash
npm install   # no runtime dependencies, but sets up the project
npm run dev
```

Then open `http://localhost:3000` in your browser.

### How it works

`npm run dev` starts `server.js` — a zero-dependency Node.js HTTP server that:
- Serves static files from `public/`
- Handles `POST /api/analyze` using the same shared investigation logic as production
- Calls real Explorer API, The Graph Network registry, and Cloudflare Workers AI

No `vercel dev` required.

### Environment variables

Copy `.env.example` to `.env.local` and fill in:

```env
# Explorer API (Etherscan or compatible)
EXPLORER_API_KEY=your_etherscan_api_key
EXPLORER_API_URL=https://api.etherscan.io/api

# The Graph — API key for the decentralized network gateway
GRAPH_API_KEY=your_graph_api_key

# The Graph Network registry endpoint (decentralized)
GRAPH_NETWORK_URL=your_registry_endpoint

# Top-N subgraphs by queryFeesAmount (default 3)
TOP_SUBGRAPHS_FOR_STATISTICS=3

# Max records per entity per subgraph (default 25)
GRAPH_QUERY_MAX_ITEMS=25

# Cloudflare Workers AI
CLOUDFLARE_ACCOUNT_ID=your_cloudflare_account_id
CLOUDFLARE_API_TOKEN=your_cloudflare_api_token
CLOUDFLARE_AI_MODEL=@cf/google/gemma-4-26b-a4b-it

# Local server port (optional, default 3000)
PORT=3000
```

`.env.local` is loaded automatically by `npm run dev` via Node's `--env-file` flag and is gitignored.

### Environment variable reference

| Variable | Description |
|---|---|
| `EXPLORER_API_KEY` | Etherscan (or compatible) API key for source code retrieval |
| `EXPLORER_API_URL` | Explorer API base URL (default: `https://api.etherscan.io/api`) |
| `GRAPH_API_KEY` | The Graph API key for the decentralized network gateway |
| `GRAPH_NETWORK_URL` | The Graph Network registry endpoint for subgraph discovery |
| `TOP_SUBGRAPHS_FOR_STATISTICS` | Top-N subgraphs by queryFees to use as evidence (default: 3) |
| `GRAPH_QUERY_MAX_ITEMS` | Max records to fetch per entity per subgraph (default: 25) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers AI permissions |
| `CLOUDFLARE_AI_MODEL` | Workers AI model (default: `@cf/google/gemma-4-26b-a4b-it`) |
| `PORT` | Local dev server port (default: 3000) |

---

## Deployment

### Deploy to Vercel

```bash
vercel
```

Set environment variables in the Vercel dashboard (Project → Settings → Environment Variables). The project is compatible with Vercel Hobby tier.

The Vercel adapter (`api/analyze.js`) imports the shared investigation logic from `lib/investigate.js`, so local and production behavior are identical.

---

## API

### `POST /api/analyze`

**Request:**
```json
{ "address": "0x..." }
```

**Response (success):**
```json
{
  "success": true,
  "address": "0x...",
  "contract": {
    "name": "...",
    "verified": true,
    "proxy": false,
    "implementation": null,
    "compiler": "v0.8.20+commit.a1b79de6"
  },
  "graph": {
    "available": true,
    "sourcesCount": 2,
    "sources": [
      {
        "subgraph": { "id": "Qm...", "name": "messari/protocol", "network": "mainnet" },
        "queryFeesAmount": 125000,
        "signalledTokens": 50000,
        "fields": {
          "transactions": ["id", "timestamp", "from", "to", "amount"],
          "financialsDailySnapshots": ["id", "date", "totalValueLockedUSD"]
        },
        "records": {
          "transactions": [
            { "id": "0x...", "timestamp": "1700000000", "from": "0x...", "to": "0x...", "amount": "100" }
          ],
          "financialsDailySnapshots": []
        }
      }
    ]
  },
  "report": {
    "executiveSummary": "...",
    "riskLevel": "MODERATE CONCERN",
    "whatItDoes": "...",
    "whoControlsIt": "...",
    "decentralization": "...",
    "technicalMechanisms": [],
    "whatCouldGoWrong": [],
    "onChainEvidence": [],
    "marketingVsReality": [],
    "positiveSignals": [],
    "keyFindings": [],
    "finalVerdict": "...",
    "bottomLine": "..."
  }
}
```

**Response (Graph unavailable — investigation continues):**
```json
{
  "graph": {
    "available": false,
    "reason": "No suitable Subgraph available for this contract"
  }
}
```

---

## Risk levels

| Level | Meaning |
|---|---|
| LOW CONCERN | Minimal centralization or risk factors |
| MODERATE CONCERN | Some privileged mechanisms or dependencies |
| HIGH CONCERN | Significant centralization, upgradeability, or fund risks |
| VERY HIGH CONCERN | Severe concentration of power or active risk mechanisms |

Risk is not based on function counting — it depends on actual privilege, impact, evidence, and context.

---

## Evidence model

Every finding is categorized as:

- **FACT** — directly supported by source code, ABI, or Graph data
- **INTERPRETATION** — reasoning based on one or more facts
- **UNKNOWN** — cannot be established from available data

The AI is instructed to never invent functions, addresses, transactions, events, balances, permissions, or Graph data.

---

## Limitations

- **Ethereum Mainnet only** — no multi-chain support
- **Requires verified source code** for code-level analysis
- **Graph coverage depends on available Subgraphs** — not every contract has one
- **AI analysis is not a formal security audit** — findings should be independently verified
- **Cloudflare Workers AI free tier** — if the daily allowance is exhausted, a clear error is returned

---

## License

MIT
