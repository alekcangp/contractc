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

No registration. No wallet connection. No API keys. No database.

---

## Architecture

```
Contract address
      ↓
Explorer API (verified source + ABI)
      ↓
The Graph (schema-aware subgraph discovery + query)
      ↓
Cloudflare Workers AI (investigation)
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

The Graph is a **load-bearing** part of ContractCritic — not decorative.

```
Source code = capabilities (what the contract CAN do)
The Graph = observed activity (what has actually been happening on-chain)
AI = reasoning over both
```

### Schema-aware subgraph querying

ContractCritic does **not** assume a fixed subgraph schema. Instead it:

1. **Introspects** the configured subgraph's GraphQL schema using `__schema` introspection
2. **Discovers** which entity types actually exist (e.g. `transactions`, `transfers`, `financialsDailySnapshots`, `swaps`)
3. **Builds a query** using only entities and fields that the subgraph actually supports
4. **Normalizes** the results into an evidence package
5. **Passes** the evidence into the AI prompt with explicit instructions to reason over it

This means ContractCritic works with any subgraph deployed on The Graph Network — DeFi, NFT, governance, or custom — without hard-coding entity names.

### How the AI uses Graph evidence

The AI is explicitly instructed to:

- Use The Graph evidence in its reasoning
- Distinguish facts from source code vs. facts from The Graph
- Connect code capabilities with observed on-chain activity
- Never invent Graph data

Example reasoning the AI should produce:

```
FACT (source code): The contract contains an admin role capable of changing critical parameters.
FACT (The Graph): Graph data shows repeated activity associated with the privileged mechanism.
INTERPRETATION: The administrative control is not merely theoretical — it has been actively used,
representing a meaningful centralization dependency.
```

### Honest handling when no subgraph is available

If no suitable subgraph exists, or if the Graph request fails, the report clearly states:

```
The Graph: No suitable Subgraph was available for this contract.
```

The investigation continues with source-code evidence only. No fake green checkmark is shown.

---

## Subgraph MCP

### What is Subgraph MCP?

[Subgraph MCP](https://thegraph.com/docs/en/subgraphs/tooling/subgraph-mcp/introduction/) is an open-source Model Context Protocol server that allows MCP-compatible clients (Claude, Cline, Cursor) to discover subgraphs, inspect schemas, and run queries against The Graph Network.

### How ContractCritic uses it

**Subgraph MCP is used during development, not at runtime.**

The MCP server is a persistent process designed for interactive development-time use with MCP-compatible AI clients. It requires stdio/SSE transport and is not designed to run inside a stateless Vercel serverless function.

ContractCritic instead implements **schema-aware subgraph querying directly** using GraphQL introspection — the same capability the MCP provides (`get_schema` + `execute_query`), but via native HTTP `fetch()` calls that work in serverless environments.

This means:
- **No fake MCP wrapper** — the runtime does real schema introspection and real GraphQL queries
- **No persistent process required** — fully stateless, Vercel Hobby compatible
- **Same outcome** — discover entities, inspect schema, query data, pass to AI

### Subgraph Skills

The [Subgraph Skills](https://github.com/graphprotocol/subgraphs-skills) repository was used as implementation guidance for:
- Understanding subgraph schema patterns
- GraphQL query design best practices
- Entity discovery and field selection

### Substreams

[Substreams Skills](https://github.com/streamingfast/substreams-skills) was evaluated but **not integrated**. Substreams provides streaming data pipelines which would add significant complexity without clear benefit for this MVP's use case (one-shot investigation queries). Substreams remains potential future work.

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
- Calls real Explorer API, The Graph, and Cloudflare Workers AI

No `vercel dev` required.

### Environment variables

Copy `.env.example` to `.env.local` and fill in:

```env
# Explorer API (Etherscan or compatible)
EXPLORER_API_KEY=your_etherscan_api_key
EXPLORER_API_URL=https://api.etherscan.io/api

# The Graph — GraphQL endpoint for a subgraph on The Graph Network
# Example: https://gateway.thegraph.com/api/<API_KEY>/subgraphs/id/<SUBGRAPH_ID>
GRAPH_API_KEY=your_graph_api_key
GRAPH_API_URL=your_graph_endpoint_url

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
| `GRAPH_API_KEY` | The Graph API key (if required by your provider) |
| `GRAPH_API_URL` | The Graph GraphQL endpoint URL for a subgraph |
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
    "data": {
      "source": "The Graph",
      "chain": "ethereum",
      "subgraph": "Qm...",
      "entities": ["transactions", "transfers"],
      "statistics": {},
      "recentActivity": []
    }
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
    "reason": "No suitable Subgraph available"
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

## Hackathon architecture (ETHGlobal / The Graph)

```
ContractCritic combines verified smart-contract source code with live indexed
blockchain data from The Graph.

The source code tells us what the contract CAN do.
The Graph tells us what has actually been happening on-chain.
The AI reasons over both.
```

The Graph is visibly represented in the UI and report:
- The evidence sources panel shows whether Graph data was available
- The on-chain evidence section displays the subgraph deployment ID, entities found, and AI findings based on that data
- When no subgraph is available, this is shown honestly with no fake checkmark

---

## License

MIT
