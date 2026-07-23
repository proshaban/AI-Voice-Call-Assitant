# Lead Call Assistant

AI voice agent that generates and follows up lead calls for **software
development services by Shaban Khan**. It dials leads over **Vobiz**
(default; Twilio kept for future use), talks to them with **Gemini Live**,
and records everything on a single `leads` table in **PostgreSQL**.

## How it works

1. **Create a lead** (`POST /api/leads`) with a name, phone, and optionally
   what they want built, budget, and timeline.
2. The **dialer cron** (every 30s, inside the 10:00–19:00 IST window) picks up:
   - **New calls** — leads never called (`call_made=false`, no `next_date`)
   - **Follow-up calls** — leads whose scheduled `next_date` has arrived
3. Vobiz answers → the call audio streams over WebSocket
   (`/api/calls/stream`) and is bridged to **Gemini Live** in real time.
4. The agent uses two minimal tools:
   - `save_call_summary` — appends the call summary to `leads.summary[]` and
     updates `status` / `stage` / `next_date` / any lead fields it learned
   - `hangup_call` — ends the call (after saving)
5. Unanswered/busy calls are retried (`MAX_CALL_RETRIES`, spaced by
   `RETRY_WAIT_SECONDS`). If the agent never saves a summary, a fallback
   summary is generated from the transcript.
6. **Inbound calls** to the Vobiz number are answered too: known numbers get
   their history in the prompt; unknown callers get a fresh lead created.

## Lead model

| Field | Notes |
|---|---|
| `name`, `phone` | required |
| `job_description`, `budget`, `timeline` | filled by the agent as it learns them |
| `status` | `active` \| `pending` \| `ongoing` \| `completed` |
| `stage` | `first_meet` → `designing` → `development` → `testing` → `debugging` → `delivery` |
| `next_date` | when the next call/meeting is due (drives follow-up calls) |
| `summary` | JSON array of `{ text, createdAt }`, one entry per call |
| `call_made`, `on_call`, `retry` | dialer bookkeeping |

## Setup

```bash
npm install
cp .env.example .env   # fill in real values
npx prisma migrate dev --name init
npm run dev
```

## Testing locally (no Vobiz, no ngrok, no phone)

The built-in test page bridges your **browser mic ↔ Gemini Live** using the
same prompts and tools as a real call — `save_call_summary` really writes to
the lead in Postgres, so the whole loop is testable end-to-end. Only
`DATABASE_URL` and `GEMINI_API_KEY` need to be set.

```bash
# optional: stop the dialer from placing real calls while testing
# (in .env) DIALER_ENABLED=false
npm run dev
```

Then open **http://localhost:3000/test.html**:

1. Create a test lead (or pick an existing one).
2. Click **Start test call** and allow mic access — the agent greets you.
3. Talk; end the call naturally ("bye"), and the agent saves the summary and
   hangs up. Refresh the lead list to see `summary[]`/`status`/`next_date`
   updated. Start another session with the same lead to test the
   **follow-up** prompt (it now has history).

## Going live

Expose your local server publicly (Vobiz must reach it):

```bash
ngrok http 3000
```

Set `PUBLIC_BASE_URL` in `.env` to that URL. On the Vobiz number used for
inbound, set the answer URL to `POST {PUBLIC_BASE_URL}/api/calls/vobiz/inbound`.

## Creating a lead (the dialer calls it automatically)

```bash
curl -X POST http://localhost:3000/api/leads \
  -H "Content-Type: application/json" \
  -d '{"name": "Ramesh", "phone": "+919876543210", "jobDescription": "E-commerce website"}'
```

Or trigger a call immediately:

```bash
curl -X POST http://localhost:3000/api/calls/initiate \
  -H "Content-Type: application/json" \
  -d '{"leadId": "<lead-uuid>"}'
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness check |
| POST | `/api/leads` | Create a lead |
| GET | `/api/leads` | List leads (`?status=&stage=&phone=`) |
| GET | `/api/leads/:id` | Fetch one lead |
| PATCH | `/api/leads/:id` | Update a lead |
| DELETE | `/api/leads/:id` | Delete a lead |
| POST | `/api/calls/initiate` | Call a lead now (`{ leadId }`) |
| POST | `/api/calls/vobiz/answer` | Vobiz outbound answer webhook (Stream XML) |
| POST | `/api/calls/vobiz/inbound` | Vobiz inbound answer webhook |
| POST | `/api/calls/vobiz/hangup` | Vobiz hangup callback (retry bookkeeping) |
| POST | `/api/calls/twilio/voice` | Twilio voice webhook (future use) |
| POST | `/api/calls/twilio/inbound` | Twilio inbound webhook (future use) |
| POST | `/api/calls/twilio/status` | Twilio status callback (future use) |
| WS | `/api/calls/stream` | Media stream ↔ Gemini Live bridge (both providers) |

## Project structure

```
src/
├── server.ts             ← entry point: http server + WS upgrade + dialer start
├── app.ts                ← Express app (middleware + route mounting)
├── routes/
│   ├── calls.routes.ts   ← call initiation + Vobiz/Twilio webhooks
│   └── leads.routes.ts   ← leads CRUD
└── lib/
    ├── prisma.ts         ← Prisma client (Postgres)
    ├── phone.ts          ← phone normalization
    ├── callRegistry.ts   ← bridges initiate-time prompt → media-stream handler
    ├── prompt.ts         ← short lead-gen prompts (new / follow-up / inbound)
    ├── lead-tools.ts     ← save_call_summary + hangup_call tools
    ├── vobiz.ts          ← Vobiz REST + answer XML + hangup bookkeeping
    ├── twilio.ts         ← Twilio (lazy, future use)
    ├── provider.ts       ← provider switch (CALL_PROVIDER, default vobiz)
    ├── dialer.ts         ← new-call + follow-up dialer cron
    ├── gemini.ts         ← Gemini Live session + fallback summary
    ├── audio.ts          ← mulaw↔PCM conversion
    └── callSession.ts    ← media stream ↔ Gemini bridge + finalize logic
```

## Notes before going live

- **Vobiz `keepCallAlive="true"`** means closing the WebSocket does NOT end
  the call — the agent's `hangup_call` tool triggers the REST hangup.
- **In-memory call registry** only works with a single Node process. Swap for
  Redis if you scale out.
- **Gemini Live SDK surface** (`ai.live.connect`) shifts across `@google/genai`
  versions — verify against the installed version.
