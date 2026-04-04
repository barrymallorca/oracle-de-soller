/**
 * L'Oracle de Sóller — Query Worker (v2 — chunks only)
 *
 * Accepts a search query, embeds it, searches Vectorize,
 * and returns the top matching document chunks.
 * Claude is called separately in chat.js with the chunks as context.
 */

const ALLOWED_ORIGIN = "https://oracledesoller.com";
const EMBED_MODEL    = "@cf/baai/bge-m3";
const TOP_K          = 5;

function corsHeaders(origin) {
  const allowed = origin === ALLOWED_ORIGIN || origin === "http://localhost:3000" || origin === "";
  return {
    "Access-Control-Allow-Origin": allowed ? (origin || ALLOWED_ORIGIN) : ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function withCors(response, origin) {
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders(origin)).forEach(([k, v]) => headers.set(k, v));
  return new Response(response.body, { ...response, headers });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== "POST") {
      return withCors(new Response("Method not allowed", { status: 405 }), origin);
    }

    // Allow server-to-server calls from Pages Functions (no origin header)
    // Only block requests from unknown browser origins
    if (origin && origin !== ALLOWED_ORIGIN && origin !== "http://localhost:3000") {
      return new Response("Forbidden", { status: 403 });
    }

    let query;
    try {
      const body = await request.json();
      query = body.query?.trim();
      if (!query) throw new Error("Missing query");
    } catch (e) {
      return withCors(
        new Response(JSON.stringify({ error: "Invalid request body" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
        origin
      );
    }

    try {
      // 1. Embed the query
      const embedResult = await env.AI.run(EMBED_MODEL, { text: [query] });
      const queryVector = embedResult.data[0];

      // 2. Search Vectorize
      const searchResult = await env.VECTORIZE.query(queryVector, {
        topK: TOP_K,
        returnMetadata: "all",
      });

      const matches = searchResult.matches || [];

      // 3. Format chunks for context
      const chunks = matches.map((m, i) => {
        const meta = m.metadata || {};
        const source = [meta.folder, meta.filename]
          .filter(Boolean)
          .join(" / ");
        const section = meta.section ? ` — ${meta.section}` : "";
        return `[${i + 1}] ${source}${section}\n${meta.chunk_text || ""}`;
      }).filter(Boolean);

      return withCors(
        new Response(
          JSON.stringify({
            chunks,
            sources: matches.map(m => ({
              filename: m.metadata?.filename || "",
              folder: m.metadata?.folder || "",
              section: m.metadata?.section || "",
              score: m.score,
            })),
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        ),
        origin
      );
    } catch (err) {
      console.error("Oracle Worker error:", err);
      return withCors(
        new Response(
          JSON.stringify({ error: "Internal server error", detail: err.message }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        ),
        origin
      );
    }
  },
};
