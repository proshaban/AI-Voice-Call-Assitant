# Voice Call Backend (Express)
I made this app for managing appointments for local business or organisations.

## What it does

1. **`POST /api/calls/initiate`** — call any phone number.
2. Before dialing, it looks up the **most recent call summary** for that
   number in Postgres and folds it into the Gemini system prompt.
3. Twilio connects the call audio to a WebSocket (`/api/calls/stream`),
   bridging audio between Twilio and **Gemini Live** in real time.
4. When the call ends, the transcript is summarized into **100-200 words**
   by Gemini.
5. That summary is saved to **Postgres** (`calls` table) and embedded +
   upserted into **Pinecone**.

## Setup

```bash
npm install
cp .env.example .env   # fill in real values
npx prisma migrate dev --name init
npm run dev
```

Expose your local server publicly (Twilio needs to reach it):

```bash
ngrok http 3000
```

Set `PUBLIC_BASE_URL` in `.env` to that ngrok URL. Create a Pinecone index
named whatever you put in `PINECONE_INDEX`, with a vector dimension matching
your embedding model's output (check Pinecone/Gemini docs for the exact
number for `gemini-embedding-001` before creating the index).

## Making a call

```bash
curl -X POST http://localhost:3000/api/calls/initiate \
  -H "Content-Type: application/json" \
  -d '{"phone": "+919876543210", "name": "Ramesh"}'
```

A successful response looks like:
```json
{ "success": true, "data": { "callSid": "CAxxxx...", "phone": "+91...", "usedPreviousSummary": false } }
```

If you don't get a real `callSid` back, the call was never placed — check
the error message in the response. If you do get one but the phone never
rings, check Twilio Console → Monitor → Logs → Calls (trial account
restrictions and unverified numbers are the most common cause).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Basic liveness check |
| POST | `/api/calls/initiate` | Start an outbound call |
| POST | `/api/calls/webhook/voice` | Twilio voice webhook (returns TwiML) |
| POST | `/api/calls/webhook/status` | Twilio call status callback |
| WS | `/api/calls/stream` | Twilio Media Stream ↔ Gemini Live bridge |
| GET | `/api/calls` | List saved call records (optional `?phone=`) |
| GET | `/api/calls/:id` | Fetch one call record |

## Project structure

```
src/
├── server.ts            ← entry point: http server + WS upgrade handling
├── app.ts                ← Express app (middleware + route mounting)
├── routes/
│   └── calls.routes.ts   ← all /api/calls/* HTTP routes
└── lib/
    ├── prisma.ts          ← Prisma client
    ├── phone.ts           ← phone normalization
    ├── pendingCalls.ts    ← bridges "initiate" prompt → WS handler
    ├── prompt.ts          ← system prompt builder (+ last summary)
    ├── twilio.ts          ← places call, builds TwiML
    ├── gemini.ts          ← Gemini Live session, summary, embeddings
    ├── pinecone.ts        ← embeds + upserts summary
    ├── audio.ts           ← mulaw↔PCM conversion (Twilio↔Gemini)
    └── callSession.ts     ← the actual bridge + finalize-on-hangup logic
```

## Notes before going live

- **Gemini Live SDK surface**: `gemini.ts` uses `@google/genai`'s
  `ai.live.connect(...)`. Field/event names shift across SDK versions —
  verify against what you install.
- **In-memory pending-call store** only works with a single Node process.
  Swap for Redis if you scale to multiple instances.
- **Pinecone index dimension** must match your embedding model's output size.
