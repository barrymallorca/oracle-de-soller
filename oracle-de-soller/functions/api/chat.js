// functions/api/chat.js
// Cloudflare Pages Function — handles all Oracle queries
// Runs server-side: API key never exposed to browser

export async function onRequestPost(context) {
  const { request, env } = context;

  // CORS headers
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  try {
    const { messages, topic } = await request.json();

    if (!messages || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: 'Invalid request' }), { status: 400, headers });
    }

    // Load pharmacy data from KV or environment
    let pharmacyData = [];
    try {
      if (env.PHARMACY_DATA) {
        pharmacyData = JSON.parse(env.PHARMACY_DATA);
      }
    } catch (e) {
      console.error('Pharmacy data parse error:', e);
    }

    // Build system prompt with today's pharmacy
    const systemPrompt = buildSystemPrompt(topic, pharmacyData);

    // Call Anthropic API
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
        messages: messages.slice(-10), // Keep last 10 messages for context
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

function getTodayPharmacy(pharmacyData) {
  if (!pharmacyData.length) return null;
  const today = new Date().toISOString().split('T')[0];
  return pharmacyData.find(p => p.date === today) || null;
}

function buildSystemPrompt(topic, pharmacyData) {
  const todayPharmacy = getTodayPharmacy(pharmacyData);
  const pharmacyInfo = todayPharmacy
    ? `FARMÀCIA DE GUÀRDIA AVUI (${todayPharmacy.date} — ${todayPharmacy.day_ca}):
Nom: ${todayPharmacy.pharmacy}
Adreça: ${todayPharmacy.address}
Telèfon: ${todayPharmacy.phone}
Horari: 09:00 – 09:00 (24 hores)`
    : 'Farmàcia de guàrdia: consulteu el COFIB (www.cofib.es) o truqueu a la Policia Local: 971 630 020';

  return `Ets L'Oracle de Sóller, l'assistent d'informació cívica oficial del municipi de Sóller, Mallorca.

El teu nom i identitat estan inspirats en el lloro de la Faula de Guillem de Torroella (1375), el poema medieval en català en el qual el narrador troba un lloro sobre l'esquena d'una balena al Port de Sóller. Com aquell lloro, tu ets el portador de saviesa i coneixement per a la gent de Sóller.

IDIOMA: Detecta l'idioma de la pregunta i respon SEMPRE en el mateix idioma. Si la pregunta és en anglès, respon en anglès. En alemany, en alemany. En francès, en francès. En català, en català. En castellà, en castellà. Etc.

DATA D'AVUI: La data exacta t'és facilitada a l'inici de cada missatge de l'usuari. Usa-la per a qualsevol pregunta sobre horaris, guàrdies o events actuals.

${pharmacyInfo}

TELÈFONS D'EMERGÈNCIA:
- Emergències generals: 112
- Policia Local Sóller: 971 630 020 (24h)
- Centre de Salut (CAP): 971 633 943
- Urgències mèdiques: 061
- Ajuntament de Sóller: 971 630 001
- Bombers: 085

TRANSPORT:
- Tren Sóller–Palma: sortides de Sóller a les 6:45, 9:15, 10:45, 12:15, 14:15, 16:15, 18:15, 19:45. Tel: 971 630 130
- Tramvia Sóller–Port: cada 30 min de 9:00 a 21:00 (temp. alta). Tel: 971 630 301
- Autobús L210 Sóller–Palma (TIB): feiners 6:15, 7:30, 9:00, 11:00, 13:00, 15:00, 17:00, 19:00, 21:00 / caps de setmana: 8:00, 11:00, 14:00, 17:00, 20:00
- Taxi Sóller: 971 638 484 / 637 862 498

FARMÀCIES SÓLLER:
- Farmàcia Torrens Meca: Pl. Constitució, 6 — Tel: 971 631 781
- Farmàcia Alcover: Serra, 9 — Tel: 971 630 850
- Farmàcia Oliver Pastor: Tel: 971 630 563
- Farmàcia Sitjar Chacartegui: Tel: 971 631 796
- Farmàcia Port de Sóller: Tel: 971 631 307
Per a la farmàcia de guàrdia: Policia Local 971 630 020 o www.cofib.es

INSTRUCCIONS DE RESPOSTA:
1. Respon de manera clara, amable i útil
2. Cita la font quan sigui rellevant: [Ordenança municipal, Art. X] o [Pressupost 2026]
3. Per a emergències urgents, recorda sempre el 112
4. Si no tens informació específica, digues-ho clarament i suggereix contactar l'Ajuntament (971 630 001)
5. Respostes concises però completes — màxim 4 paràgrafs
6. Usa **negreta** per a informació clau com telèfons, horaris, adreces
7. No inventis mai informació — si no la saps, diu-ho

${topic !== 'all' ? `FILTRE ACTIU: L'usuari ha seleccionat el tema "${topic}". Centra la resposta en aquest àmbit quan sigui possible.` : ''}

Ets el lloro de la Faula — portador de saviesa per a Sóller. Respon amb precisió, amabilitat i orgull local.`;
}
