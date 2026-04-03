#!/usr/bin/env node
/**
 * L'Oracle de Sóller — Vectorize Ingestion Script
 *
 * Reads all PDFs and Google Docs from a Google Drive folder,
 * chunks them, embeds via Cloudflare Workers AI (multilingual-e5-large),
 * and upserts into Cloudflare Vectorize.
 *
 * Run: node scripts/ingest.js
 * Re-run any time docs change — existing vectors are overwritten by ID.
 */

import { google } from "googleapis";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { encoding_for_model } from "tiktoken";
import fetch from "node-fetch";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;         // Your Drive folder ID
const CF_ACCOUNT_ID   = process.env.CF_ACCOUNT_ID;           // Cloudflare account ID
const CF_API_TOKEN    = process.env.CF_API_TOKEN;             // Cloudflare API token
const VECTORIZE_INDEX = process.env.VECTORIZE_INDEX || "oracle-soller-index";

const CHUNK_TOKENS   = 600;   // Target chunk size in tokens
const OVERLAP_TOKENS = 150;   // Overlap between chunks
const BATCH_SIZE     = 50;    // Vectors per Vectorize upsert batch
const EMBED_BATCH    = 10;    // Texts per embedding API call

// Cloudflare multilingual embedding model — 1024 dimensions
const EMBED_MODEL = "@cf/baai/bge-m3";

// ─── GOOGLE DRIVE AUTH ───────────────────────────────────────────────────────

async function getDriveClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "./service-account.json",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  return google.drive({ version: "v3", auth });
}

// ─── LIST ALL FILES IN FOLDER ────────────────────────────────────────────────

async function listFiles(drive) {
  const files = [];
  let pageToken = null;

  do {
    const res = await drive.files.list({
      q: `'${DRIVE_FOLDER_ID}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, modifiedTime)",
      pageSize: 100,
      pageToken,
    });
    files.push(...res.data.files);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  console.log(`Found ${files.length} files in Drive folder`);
  return files;
}

// ─── EXTRACT TEXT ────────────────────────────────────────────────────────────

async function extractGoogleDoc(drive, file) {
  // Export Google Doc as plain text
  const res = await drive.files.export(
    { fileId: file.id, mimeType: "text/plain" },
    { responseType: "text" }
  );
  return res.data;
}

async function extractPDF(drive, file) {
  // Download PDF to temp file, then extract text
  const tmpPath = path.join(os.tmpdir(), `oracle-${file.id}.pdf`);

  const dest = fs.createWriteStream(tmpPath);
  const res = await drive.files.get(
    { fileId: file.id, alt: "media" },
    { responseType: "stream" }
  );

  await new Promise((resolve, reject) => {
    res.data.pipe(dest);
    res.data.on("end", resolve);
    res.data.on("error", reject);
  });

  // Extract text using pdfjs-dist
  const data = new Uint8Array(fs.readFileSync(tmpPath));
  const pdf = await getDocument({ data }).promise;

  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => item.str).join(" ");
    text += pageText + "\n\n";
  }

  fs.unlinkSync(tmpPath);
  return text;
}

async function extractText(drive, file) {
  const GOOGLE_DOC = "application/vnd.google-apps.document";
  const PDF = "application/pdf";

  if (file.mimeType === GOOGLE_DOC) {
    console.log(`  → Google Doc: ${file.name}`);
    return await extractGoogleDoc(drive, file);
  } else if (file.mimeType === PDF) {
    console.log(`  → PDF: ${file.name}`);
    return await extractPDF(drive, file);
  } else {
    console.log(`  ⚠ Skipping unsupported type: ${file.mimeType} (${file.name})`);
    return null;
  }
}

// ─── CHUNKING ────────────────────────────────────────────────────────────────

function detectLanguage(filename) {
  const lower = filename.toLowerCase();
  if (lower.startsWith("ca_")) return "ca";
  if (lower.startsWith("es_")) return "es";
  if (lower.startsWith("en_")) return "en";
  return "unknown"; // Will be fine — multilingual model handles it
}

function detectSection(text, chunkStart) {
  // Walk backwards from chunkStart looking for a heading-like line
  const before = text.slice(0, chunkStart);
  const lines = before.split("\n").reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    // Heading heuristics: ALL CAPS, or starts with Article/Artículo/Article/Capítol/Capítulo
    if (
      /^(article|artículo|artícle|capítol|capítulo|chapter|secció|sección|section)\b/i.test(trimmed) ||
      (trimmed.length > 5 && trimmed.length < 80 && trimmed === trimmed.toUpperCase())
    ) {
      return trimmed;
    }
  }
  return null;
}

function chunkText(text, file) {
  const enc = encoding_for_model("gpt-4"); // tiktoken — good proxy for token counts
  const tokens = enc.encode(text);
  const chunks = [];
  let chunkIndex = 0;
  let start = 0;

  while (start < tokens.length) {
    const end = Math.min(start + CHUNK_TOKENS, tokens.length);
    const chunkTokens = tokens.slice(start, end);
    const chunkText = new TextDecoder().decode(enc.decode(chunkTokens));

    // Estimate char offset (approximate — good enough for metadata)
    const charOffset = Math.floor((start / tokens.length) * text.length);
    const section = detectSection(text, charOffset);

    chunks.push({
      id: `${file.id}_chunk_${chunkIndex}`,
      text: chunkText.trim(),
      metadata: {
        doc_id: file.id,
        filename: file.name,
        language: detectLanguage(file.name),
        section: section || "",
        chunk_index: chunkIndex,
        modified: file.modifiedTime,
      },
    });

    chunkIndex++;
    // Move forward by CHUNK_TOKENS minus OVERLAP_TOKENS
    start += CHUNK_TOKENS - OVERLAP_TOKENS;
  }

  enc.free();
  return chunks;
}

// ─── EMBEDDING ───────────────────────────────────────────────────────────────

async function embedTexts(texts) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${EMBED_MODEL}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: texts }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Embedding API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.result.data; // Array of float arrays
}

// ─── VECTORIZE UPSERT ─────────────────────────────────────────────────────────

async function upsertVectors(vectors) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/vectorize/v2/indexes/${VECTORIZE_INDEX}/upsert`;

  // Vectorize expects NDJSON format
  const ndjson = vectors
    .map((v) => JSON.stringify(v))
    .join("\n");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CF_API_TOKEN}`,
      "Content-Type": "application/x-ndjson",
    },
    body: ndjson,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Vectorize upsert error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.result;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🔍 L'Oracle de Sóller — Vectorize Ingestion");
  console.log("============================================\n");

  // Validate env
  const required = ["DRIVE_FOLDER_ID", "CF_ACCOUNT_ID", "CF_API_TOKEN"];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing env var: ${key}`);
  }

  const drive = await getDriveClient();
  const files = await listFiles(drive);

  let totalChunks = 0;
  let totalVectors = 0;
  const allChunks = [];

  // ── Extract and chunk all documents ──
  console.log("\n📄 Extracting and chunking documents...\n");
  for (const file of files) {
    const text = await extractText(drive, file);
    if (!text || text.trim().length < 50) {
      console.log(`  ⚠ Skipping empty/short: ${file.name}`);
      continue;
    }

    const chunks = chunkText(text, file);
    console.log(`  ✓ ${file.name} → ${chunks.length} chunks`);
    allChunks.push(...chunks);
    totalChunks += chunks.length;
  }

  console.log(`\n📦 Total chunks to embed: ${totalChunks}`);

  // ── Embed in batches ──
  console.log("\n🔢 Embedding chunks...\n");
  const vectors = [];

  for (let i = 0; i < allChunks.length; i += EMBED_BATCH) {
    const batch = allChunks.slice(i, i + EMBED_BATCH);
    const texts = batch.map((c) => c.text);

    process.stdout.write(`  Embedding ${i + 1}–${Math.min(i + EMBED_BATCH, allChunks.length)} of ${allChunks.length}...`);

    const embeddings = await embedTexts(texts);

    for (let j = 0; j < batch.length; j++) {
      vectors.push({
        id: batch[j].id,
        values: embeddings[j],
        metadata: batch[j].metadata,
      });
    }

    console.log(" ✓");

    // Small delay to avoid rate limits
    if (i + EMBED_BATCH < allChunks.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // ── Upsert to Vectorize ──
  console.log("\n⬆️  Upserting to Vectorize...\n");

  for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
    const batch = vectors.slice(i, i + BATCH_SIZE);
    process.stdout.write(`  Upserting ${i + 1}–${Math.min(i + BATCH_SIZE, vectors.length)} of ${vectors.length}...`);
    const result = await upsertVectors(batch);
    totalVectors += result.count || batch.length;
    console.log(" ✓");
  }

  console.log(`\n✅ Done! ${totalVectors} vectors upserted to '${VECTORIZE_INDEX}'`);
  console.log(`   ${files.length} documents → ${totalChunks} chunks → ${totalVectors} vectors\n`);
}

main().catch((err) => {
  console.error("\n❌ Ingestion failed:", err.message);
  process.exit(1);
});
