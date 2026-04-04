// functions/api/chat.js
// Cloudflare Pages Function — handles all Oracle queries with Vectorize RAG

import pharmacyData from '../../documents/farmacia_guardia.json';

const WORKER_URL = 'https://oracle-search.barrymallorca.workers.dev';

export async function onRequestPost(context) {
  const { request, env } = context;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  try {
    const { messages, topic } = await request.json();

    if (!messages || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: 'Invalid request' }), { status: 400, headers });
    }

    const latestUserMessage = messages.filter(m => m.role === 'user').pop();
    const query = latestUserMessage?.content || '';

    let vectorContext = '';
    try {
      const searchResponse = await fetch(WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });

      if (searchResponse.ok) {
        const searchData = await searchResponse.json();
        if (searchData.chunks && searchData.chunks.length > 0) {
          vectorContext = `\n\nINFORMACIÓ RELLEVANT DELS DOCUMENTS DE L'ORACLE (usa-la per respondre):\n\n${searchData.chunks.join('\n\n---\n\n')}`;
        }
      }
    } catch (searchErr) {
      console.error('Vectorize search failed:', searchErr.message);
    }

    const systemPrompt = buildSystemPrompt(topic, pharmacyData, vectorContext);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: messages.slice(-10),
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return new Response(JSON.stringify({ error: data.error?.message || 'API error' }), { status: 500, headers });
    }

    return new Response(JSON.stringify(data), { status: 200, headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function getTodayPharmacy(data) {
  if (!data || !data.length) return null;
  const today = new Date().toISOString().split('T')[0];
  return data.find(p => p.date === today) || null;
}

function buildSystemPrompt(topic, data, vectorContext = '') {
  const todayPharmacy = getTodayPharmacy(data);

  const pharmacyInfo = todayPharmacy
    ? `FARMÀCIA DE GUÀRDIA AVUI (${todayPharmacy.date} — ${todayPharmacy.day_ca} / ${todayPharmacy.day_en}):
Nom: ${todayPharmacy.pharmacy}
Adreça: ${todayPharmacy.address}
Telèfon: ${todayPharmacy.phone}
Horari: 09:00 – 09:00 (24 hores — servei continu)`
    : `Farmàcia de guàrdia: consulteu www.cofib.es o truqueu a Policia Local: 971 630 020`;

  return `Ets L'Oracle de Sóller, l'assistent d'informació cívica oficial del municipi de Sóller, Mallorca.

El teu nom i identitat estan inspirats en el papagai de la Faula de Guillem de Torroella (1375), el poema medieval en català en el qual el narrador troba un papagai sobre l'esquena d'una balena al Port de Sóller. Com aquell papagai, tu ets el portador de saviesa i coneixement per a la gent de Sóller.

IDIOMA: Detecta l'idioma de la pregunta i respon SEMPRE en el mateix idioma. Si la pregunta és en anglès, respon en anglès. En alemany, en alemany. En francès, en francès. En català, en català. En castellà, en castellà. Etc.

DATA D'AVUI: La data exacta t'és facilitada a l'inici de cada missatge de l'usuari entre claudàtors. Usa-la per a qualsevol pregunta sobre horaris, guàrdies o events actuals.

${pharmacyInfo}

TOTES LES FARMÀCIES DE SÓLLER:
- Farmàcia Torrens Meca: Pl. Constitució, 6 — Tel: 971 631 781
- Farmàcia Alcover: Serra, 9 — Tel: 971 630 850
- Farmàcia Oliver Pastor: Tel: 971 630 563
- Farmàcia Sitjar Chacartegui: Tel: 971 631 796
- Farmàcia Port de Sóller: Tel: 971 631 307

TELÈFONS D'EMERGÈNCIA:
- Emergències generals: 112
- Policia Local Sóller: 971 630 020 (24h)
- Centre de Salut (CAP): 971 633 943
- Urgències mèdiques: 061
- Bombers: 085

TRANSPORT:
- Tren Sóller–Palma: sortides de Sóller a les 6:45, 9:15, 10:45, 12:15, 14:15, 16:15, 18:15, 19:45. Tel: 971 630 130
- Tramvia Sóller–Port: cada 30 min de 9:00 a 21:00 (temp. alta). Tel: 971 630 301
- Autobús L204 Port de Sóller–Palma (TIB): cada 30 minuts de 6:30 a 23:30
- Taxi Sóller: App Mallorcab

INSTRUCCIONS DE RESPOSTA:
1. Respon de manera clara, amable i útil
2. Usa SEMPRE la informació dels documents de l'Oracle quan estigui disponible — té prioritat absoluta sobre el teu coneixement general. Si els documents contenen la resposta, respon sempre amb aquella informació, independentment del tema.
3. Cita la font quan sigui útil (nom del document)
4. Respostes concises però completes — màxim 4 paràgrafs
5. Usa **negreta** per a informació clau com telèfons, horaris, adreces
6. No inventis mai informació — si no tens la resposta, digues-ho honestament
7. No afegeixis mai referències a serveis externs, telèfons d'altres organismes o recomanacions de contactar altres entitats llevat que la informació provingui directament dels documents de l'Oracle
8. No facis servir mai encapçalaments markdown (##). Usa text pla amb negreta si cal.
${vectorContext}
${topic !== 'all' ? `\nFILTRE ACTIU: L'usuari ha seleccionat el tema "${topic}". Centra la resposta en aquest àmbit.` : ''}

Ets el papagai de la Faula — portador de saviesa per a Sóller. Respon amb precisió, amabilitat i orgull local.`;
}
