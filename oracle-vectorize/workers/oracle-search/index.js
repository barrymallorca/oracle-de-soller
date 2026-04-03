/**
 * L'Oracle de Sóller — Query Worker
 *
 * Accepts a search query, embeds it, searches Vectorize,
 * then calls Claude with the retrieved context to generate an answer.
 *
 * Bound to: oracle-soller-index (Vectorize)
 *           AI (Workers AI)
 * Rate limit: 20 requests per IP per minute
 */

const ALLOWED_ORIGIN = "https://oracledesoller.com";
const EMBED_MODEL    = "@cf/baai/bge-m3";
const CLAUDE_MODEL   = "claude-sonnet-4-20250514";
const TOP_K          = 5; // Number of chunks to retrieve

// ─── CORS HEADERS ─────────────────────────────────────────────────────────────

function corsHeaders(origin) {
  const allowed = origin === ALLOWED_ORIGIN || origin === "http://localhost:3000";
  return {
    "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGIN,
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

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────

function buildSystemPrompt(language) {
  const prompts = {
    ca: `Ets L'Oracle de Sóller, un assistent cívic amable i ben informat per a la ciutat de Sóller, Mallorca.
Respon sempre en català mallorquí càlid i clar.
Utilitza NOMÉS la informació dels documents proporcionats. Si no trobes la resposta, digues-ho honestament.
Cita la font quan sigui útil (nom del document i secció si és possible).`,

    es: `Eres L'Oracle de Sóller, un asistente cívico amable y bien informado para la ciudad de Sóller, Mallorca.
Responde siempre en español claro y cálido.
Usa SOLO la información de los documentos proporcionados. Si no encuentras la respuesta, dilo honestamente.
Cita la fuente cuando sea útil (nombre del documento y sección si es posible).`,

    en: `You are L'Oracle de Sóller, a warm and knowledgeable civic assistant for the town of Sóller, Mallorca.
Always respond in clear, friendly English.
Use ONLY the information from the provided documents. If you cannot find the answer, say so honestly.
Cite the source when helpful (document name and section where possible).`,
  };

  return prompts[language] || prompts.ca;
}

// ─── DETECT LANGUAGE ─────────────────────────────────────────────────────────

function detectLanguage(text) {
  // Simple heuristic — can be replaced with a proper detector
  const ca = /\b(el|la|els|les|és|són|com|per|que|amb|una|un|del|al|aquest|aquesta)\b/gi;
  const es = /\b(el|la|los|las|es|son|como|por|que|con|una|un|del|al|este|esta)\b/gi;
  const en = /\b(the|is|are|how|what|where|when|can|for|with|this|that|and)\b/gi;

  const caCount = (text.match(ca) || []).length;
  const esCount = (text.match(es) || []).length;
  const enCount = (text.match(en) || []).length;

  if (enCount > caCount && enCount > esCount) return "en";
  if (esCount > caCount) return "es";
  return "ca"; // Default to Catalan
}

// ─── FORMAT CONTEXT ───────────────────────────────────────────────────────────

function formatContext(matches) {
  return matches
    .map((match, i) => {
      const m = match.metadata || {};
      const source = [m.filename, m.section].filter(Boolean).join(" — ");
      return `[Document ${i + 1}: ${source}]\n${m.text_preview || "(see chunk)"}`;
    })
    .join("\n\n---\n\n");
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Only allow POST
    if (request.method !== "POST") {
      return withCors(new Response("Method not allowed", { status: 405 }), origin);
    }

    // Parse request body
    let query, conversationHistory;
    try {
      const body = await request.json();
      query = body.query?.trim();
      conversationHistory = body.history || []; // Optional: for multi-turn
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
      // ── 1. Embed the query ──
      const embedResult = await env.AI.run(EMBED_MODEL, { text: [query] });
      const queryVector = embedResult.data[0];

      // ── 2. Search Vectorize ──
      const searchResult = await env.VECTORIZE.query(queryVector, {
        topK: TOP_K,
        returnMetadata: "all",
      });

      const matches = searchResult.matches || [];

      // ── 3. Detect query language and build prompt ──
      const language = detectLanguage(query);
      const systemPrompt = buildSystemPrompt(language);

      // Build context from retrieved chunks
      const context = matches.length > 0
        ? matches.map((m, i) => {
            const meta = m.metadata || {};
            const source = [meta.filename, meta.section].filter(Boolean).join(" — ");
            return `[${i + 1}] ${source}\n${meta.chunk_text || ""}`;
          }).join("\n\n---\n\n")
        : "No relevant documents found.";

      // ── 4. Call Claude with RAG context ──
      const messages = [
        ...conversationHistory,
        {
          role: "user",
          content: `Context from Oracle documents:\n\n${context}\n\n---\n\nUser question: ${query}`,
        },
      ];

      const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 1024,
          system: systemPrompt,
          messages,
        }),
      });

      if (!claudeRes.ok) {
        const err = await claudeRes.text();
        throw new Error(`Claude API error ${claudeRes.status}: ${err}`);
      }

      const claudeData = await claudeRes.json();
      const answer = claudeData.content?.[0]?.text || "";

      // ── 5. Return answer + sources ──
      const sources = matches.map((m) => ({
        filename: m.metadata?.filename || "",
        section: m.metadata?.section || "",
        language: m.metadata?.language || "",
        score: m.score,
      }));

      return withCors(
        new Response(
          JSON.stringify({ answer, sources, language }),
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
