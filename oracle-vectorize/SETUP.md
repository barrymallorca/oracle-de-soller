# L'Oracle de Sóller — Vectorize Setup Guide

## Overview

This adds RAG (Retrieval-Augmented Generation) to the Oracle:
your 106 Google Drive documents are chunked, embedded, and stored
in Cloudflare Vectorize. When a user asks a question, the Oracle
retrieves the most relevant document chunks and passes them to Claude.

```
Google Drive (106 docs)
  ↓ [ingest.js — run once, then on updates]
Cloudflare Vectorize  ←→  Workers AI (multilingual embeddings)
  ↓ [query time]
oracle-search Worker  →  Claude API  →  Answer + sources
  ↓
oracledesoller.com frontend
```

---

## Step 1 — Create the Vectorize index

Run this once from your terminal (wrangler must be authenticated):

```bash
npx wrangler vectorize create oracle-soller-index \
  --dimensions=1024 \
  --metric=cosine
```

1024 dimensions matches the `bge-m3` multilingual embedding model.

---

## Step 2 — Set up Google Drive API access

You need a **service account** so the ingestion script can read your Drive folder.

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a project (or use an existing one)
3. Enable the **Google Drive API**
4. Create a **Service Account** (IAM → Service Accounts → Create)
5. Download the JSON key → save as `scripts/service-account.json`
6. In Google Drive, **share your Oracle documents folder** with the
   service account email (e.g. `oracle-ingest@your-project.iam.gserviceaccount.com`)
   — give it Viewer access

> ⚠️ Add `service-account.json` to `.gitignore` — never commit it.

---

## Step 3 — Configure the ingestion script

```bash
cd scripts
cp .env.example .env
```

Edit `.env` and fill in:
- `DRIVE_FOLDER_ID` — the ID from your Drive folder URL
- `CF_ACCOUNT_ID` — from Cloudflare dashboard right sidebar
- `CF_API_TOKEN` — create at dash.cloudflare.com/profile/api-tokens
  (needs permissions: Workers AI:Read, Vectorize:Edit)

---

## Step 4 — Run the ingestion

```bash
cd scripts
npm install
npm run ingest
```

You'll see output like:
```
📄 Extracting and chunking documents...
  → Google Doc: ca_bylaw_circulacio-soller
  ✓ ca_bylaw_circulacio-soller → 14 chunks
  → PDF: ajuntament-reglament-2023.pdf
  ✓ ajuntament-reglament-2023.pdf → 31 chunks
  ...
📦 Total chunks to embed: 847
🔢 Embedding chunks...
  Embedding 1–10 of 847... ✓
  ...
⬆️  Upserting to Vectorize...
✅ Done! 847 vectors upserted to 'oracle-soller-index'
```

Re-run any time you add or update documents.

---

## Step 5 — Deploy the query Worker

```bash
cd workers/oracle-search
npm install  # or: npm init -y && npm install wrangler
```

Add your Anthropic API key as a secret (never in wrangler.toml):
```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

Deploy:
```bash
npx wrangler deploy --config wrangler.toml
```

Your Worker will be live at:
`https://oracle-search.YOUR-SUBDOMAIN.workers.dev`

---

## Step 6 — Connect the frontend

In your Oracle frontend, replace the direct Claude API call with
a call to the Worker:

```javascript
const response = await fetch("https://api.oracledesoller.com/search", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    query: userMessage,
    history: conversationHistory  // Optional: for multi-turn
  })
});

const { answer, sources, language } = await response.json();
```

The Worker returns:
```json
{
  "answer": "Segons el Reglament de Circulació...",
  "sources": [
    {
      "filename": "ca_bylaw_circulacio-soller",
      "section": "CAPÍTOL III — APARCAMENT",
      "language": "ca",
      "score": 0.91
    }
  ],
  "language": "ca"
}
```

---

## Filename convention for Drive documents

Use this pattern for best metadata quality:

```
ca_bylaw_circulacio-soller-2023        ← Google Doc (Catalan bylaw)
es_guide_transport-soller              ← Google Doc (Spanish guide)  
en_info_pharmacies                     ← Google Doc (English info)
ajuntament-reglament-2021.pdf          ← PDF (external official doc)
```

Language prefix (`ca_`, `es_`, `en_`) helps the Oracle cite sources clearly.
For PDFs from external sources, the filename doesn't need a prefix —
the multilingual model handles them regardless.

---

## Re-indexing workflow

When you add or update documents:

1. Add/update the file in your Google Drive folder
2. Run `npm run ingest` from the `scripts/` directory
3. Existing vectors are overwritten by document ID — no duplicates

No need to delete and recreate the index.

---

## Costs (Cloudflare free tier)

- **Vectorize**: 5M vector dimensions stored free, 50M queried/month free
  → Your 106 docs at ~850 chunks × 1024 dimensions = ~870K stored
  → Well within free tier
- **Workers AI**: First 10K neurons/day free (embeddings + inference)
- **Workers**: 100K requests/day free

You are unlikely to pay anything until the Oracle scales significantly.

