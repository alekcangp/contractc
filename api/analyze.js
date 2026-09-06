// ContractCritic — Vercel Serverless Function adapter
// Delegates all investigation logic to the shared module (lib/investigate.js).

import { investigate } from "../lib/investigate.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ success: false, error: "Method not allowed" }), {
      status: 405,
      headers: CORS_HEADERS,
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ success: false, error: "Invalid request body" }), {
      status: 400,
      headers: CORS_HEADERS,
    });
  }

  const address = typeof body.address === "string" ? body.address.trim() : "";

  const result = await investigate(address);

  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: CORS_HEADERS,
  });
}
