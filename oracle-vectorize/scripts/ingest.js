#!/usr/bin/env node
/**
 * L'Oracle de Sóller — Vectorize Ingestion Script (v3)
 *
 * Reads all PDFs and Google Docs from a Google Drive folder (recursively),
 * chunks them, embeds via Cloudflare Workers AI (bge-m3 multilingual),
 * and upserts into Cloudflare Vectorize.
 *
 * Run: node ingest.js
 * Re-run any time docs change — existing vectors are overwritten by ID.
 */

import { google } from "googleapis";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { encoding_for_model } from "tiktoken";
import fetch from "node-fetch";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import dotenv from "dotenv";

dotenv.config();

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
const CF_ACCOUNT_ID   = process.env.CF_ACCOUNT_ID   || process.env.CLOUDFLARE_ACCOUNT_ID;
const CF_API_TOKEN    = process.env.CF_API_TOKEN     || process.env.CLOUDFLARE_API_TOKEN;
const VECTORIZE_INDEX = process.env.VECTORIZE_INDEX  || "oracle-soller-index";

const CHUNK_TOKENS   = 600;
const OVERLAP_TOKENS = 150;
const BATCH_SIZE     = 50;
const EMBED_BATCH    = 10;

const EMBED_MODEL = "@cf/baai/bge-m3";

const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const PDF_MIME        = "application/pdf";
const FOLDER_MIME     = "application/vnd.google-apps.folder";

// ─── GOOGLE DRIVE AUTH ───────────────────────────────────────────────────────

async function getDriveClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "./service-account.json",
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  return google.drive({ version: "v3", auth });
}

// ─── LIST ALL FILES RECURSIVELY ──────────────────────────────────────────────

async function listFilesRecursive(drive, folderId, folderPath = "") {
  const files = [];
  let pageToken = null;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, modifiedTime)",
      pageSize: 100,
      pageToken,
    });

    for (const file of res.data.files) {
      if (file.mimeType === FOLDER_MIME) {
        const subPath = folderPath ? `${folderPath}/${file.name}` : file.name;
        console.log(`  📁 Scanning subfolder: ${subPath}`);
        const subFiles = await listFilesRecursive(drive, file.id, subPath);
        files.push(...subFiles);
      } else {
        file.folderPath = folderPath;
        files.push(file);
      }
    }

    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return files;
}

// ─── EXTRACT TEXT ────────────────────────────────────────────────────────────

async function extractGoogleDoc(drive, file) {
  const res = await drive.files.export(
    { fileId: file.id, mimeType: "text/plain" },
    { responseType: "text" }
  );
  return res.data;
}

async function extractPDF(drive, file) {
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

  try {
    const data = new Uint8Array(fs.readFileSync(tmpPath));
    const pdf = await getDocument({ data, verbosity: 0 }).promise;

    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      try {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const pageText = content.items.map((item) => item.str).join(" ");
        text += pageText + "\n\n";
      } catch (pageErr) {
        console.log(`    ⚠ Could not extract page ${i} — skipping`);
      }
    }

    fs.unlinkSync(tmpPath);
    return text;
  } catch (err) {
    console.log(`    ⚠ pdfjs failed (${err.message.slice(0, 60)}), trying fallback...`);
    try {
      const raw = fs.readFileSync(tmpPath, "latin1");
      const matches = raw.match(/BT[\s\S]*?ET/g) || [];
      const text = matches
        .join(" ")
        .replace(/\(([^)]+)\)/g, "$1 ")
        .replace(/[^\x20-\x7E\n]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      fs.unlinkSync(tmpPath);
      return text.length > 100 ? text : null;
    } catch {
      fs.unlinkSync(tmpPath);
      return null;
    }
  }
}

async function extractText(drive, file) {
  if (file.mimeType === GOOGLE_DOC_MIME) return await extractGoogleDoc(drive, file);
  if (file.mimeType === PDF_MIME) return await extractPDF(drive, file);
  return null;
}

// ─── CHUNKING ────────────────────────────────────────────────────────────────

function detectLanguage(filename, folderPath) {
  const lower = (folderPath + "/" + filename).toLowerCase();
  if (lower.startsWith("ca_") || lower.includes("/ca_")) return "ca";
  if (lower.startsWith("es_") || lower.includes("/es_")) return "es";
  if (lower.startsWith("en_") || lower.includes("/en_")) return "en";
  return "unknown";
}

function detectSection(text, chunkStart) {
  const before = text.slice(0, chunkStart);
  const lines = before.split("\n").reverse();
  for (const line of lines) {
    const trimmed = line.trim();
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
  const enc = encoding_for_model("gpt-4");
  const tokens = enc.encode(text);
  const chunks = [];
  let chunkIndex = 0;
  let start = 0;

  while (start < tokens.length) {
    const end = Math.min(start + CHUNK_TOKENS, tokens.length);
    const chunkTokens = tokens.slice(start, end);
    const chunkContent = new TextDecoder().decode(enc.decode(chunkTokens));
    const charOffset = Math.floor((start / tokens.length) * text.length);
    const section = detectSection(text, charOffset);

    chunks.push({
      id: `${file.id}_chunk_${chunkIndex}`,
      text: chunkContent.trim(),
      metadata: {
        doc_id: file.id.slice(0, 50),
        filename: file.name.slice(0, 100),
        folder: (file.folderPath || "").slice(0, 50),
        language: detectLanguage(file.name, file.folderPath || ""),
        section: (section || "").slice(0, 100),
        chunk_index: chunkIndex,
        chunk_text: chunkContent.trim().slice(0, 300),
        modified: file.modifiedTime,
      },
    });

    chunkIndex++;
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
  return data.result.data;
}

// ─── VECTORIZE UPSERT ────────────────────────────────────────────────────────

async function upsertVectors(vectors) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/vectorize/v2/indexes/${VECTORIZE_INDEX}/upsert`;

  const ndjson = vectors.map((v) => JSON.stringify(v)).join("\n");

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

  const required = ["DRIVE_FOLDER_ID", "CF_ACCOUNT_ID", "CF_API_TOKEN"];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing env var: ${key}`);
  }

  const drive = await getDriveClient();

  console.log("📁 Scanning Drive folder (including subfolders)...\n");
  const files = await listFilesRecursive(drive, DRIVE_FOLDER_ID);

  const docFiles = files.filter(
    (f) => f.mimeType === GOOGLE_DOC_MIME || f.mimeType === PDF_MIME
  );

  console.log(`\nFound ${docFiles.length} documents across all folders\n`);

  let totalChunks = 0;
  const allChunks = [];
  const failed = [];

  console.log("📄 Extracting and chunking documents...\n");
  for (const file of docFiles) {
    const label = file.folderPath ? `${file.folderPath}/${file.name}` : file.name;
    const type = file.mimeType === GOOGLE_DOC_MIME ? "Google Doc" : "PDF";
    process.stdout.write(`  [${type}] ${label}... `);

    try {
      const text = await extractText(drive, file);
      if (!text || text.trim().length < 50) {
        console.log("⚠ empty or too short, skipping");
        failed.push({ name: label, reason: "empty" });
        continue;
      }

      const chunks = chunkText(text, file);
      console.log(`✓ ${chunks.length} chunks`);
      allChunks.push(...chunks);
      totalChunks += chunks.length;
    } catch (err) {
      console.log(`❌ ${err.message.slice(0, 80)}`);
      failed.push({ name: label, reason: err.message.slice(0, 80) });
    }
  }

  if (allChunks.length === 0) {
    console.log("\n❌ No chunks to embed. Check your documents and try again.");
    return;
  }

  console.log(`\n📦 Total chunks to embed: ${totalChunks}`);

  console.log("\n🔢 Embedding chunks...\n");
  const vectors = [];

  for (let i = 0; i < allChunks.length; i += EMBED_BATCH) {
    const batch = allChunks.slice(i, i + EMBED_BATCH);
    process.stdout.write(
      `  ${i + 1}–${Math.min(i + EMBED_BATCH, allChunks.length)} of ${allChunks.length}... `
    );

    const embeddings = await embedTexts(batch.map((c) => c.text));

    for (let j = 0; j < batch.length; j++) {
      vectors.push({
        id: batch[j].id,
        values: embeddings[j],
        metadata: batch[j].metadata,
      });
    }

    console.log("✓");
    if (i + EMBED_BATCH < allChunks.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  console.log("\n⬆️  Upserting to Vectorize...\n");
  let totalVectors = 0;

  for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
    const batch = vectors.slice(i, i + BATCH_SIZE);
    process.stdout.write(
      `  ${i + 1}–${Math.min(i + BATCH_SIZE, vectors.length)} of ${vectors.length}... `
    );
    const result = await upsertVectors(batch);
    totalVectors += result.count || batch.length;
    console.log("✓");
  }

  console.log(`\n✅ Done! ${totalVectors} vectors upserted to '${VECTORIZE_INDEX}'`);
  console.log(`   ${docFiles.length} documents → ${totalChunks} chunks → ${totalVectors} vectors`);

  if (failed.length > 0) {
    console.log(`\n⚠️  ${failed.length} document(s) could not be processed:`);
    failed.forEach((f) => console.log(`   - ${f.name}: ${f.reason}`));
  }

  console.log("");
}

main().catch((err) => {
  console.error("\n❌ Ingestion failed:", err.message);
  process.exit(1);
});
