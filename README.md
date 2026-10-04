# IndbyAgent

**Every invite is a link a person can read and an agent can answer.**

A guest opens `https://indbyagent.com/i/<token>` and sees the party. A guest's *agent* opens the same link and gets structured JSON, with the exact calls to RSVP, answer polls and message the host. No form, no login, no human in the loop unless one is needed.

Built at SF Tech Week 2026 (Build Personal Agents Hack). Inspired by the agent design of [Bullpen](https://bullpen.sale).

## The invite, four ways

| Request | You get |
|---|---|
| `GET /i/<token>` (browser) | The invite page: party info, RSVP buttons, open polls, and a **"For your agent"** box |
| `GET /i/<token>.json` or `Accept: application/json` | The invite as JSON, with `actions` and a `schema` block |
| `GET /i/<token>.txt` | A 10-line plain summary with copy-paste curl commands |
| `GET /i/<token>.ics` | Calendar file |

**GET never changes anything.** Mail scanners and link previews prefetch invite links; only a POST can RSVP.

## Join by QR
A host can publish a **join link** (`/j/<code>`) and put its QR code on a screen (`/q/<code>`, with live counters). A person scans it, types a name, and gets a personal invite link. An agent joins with one call:

```bash
curl -s -X POST https://indbyagent.com/j/<code>/join -H 'content-type: application/json' \
  -d '{"name":"Leo Chen","email":"leo@example.com","by":{"kind":"agent","name":"Claude"}}'
# → { "invite_url": "https://indbyagent.com/i/<token>", ... }
```

## Actions (POST, JSON)

```bash
# RSVP
curl -s -X POST https://indbyagent.com/i/<token>/rsvp -H 'content-type: application/json' \
  -d '{"status":"yes","party_size":2,"dietary":["tree nuts"],"note":"Leo is allergic to nuts","by":{"kind":"agent","name":"Claude"}}'

# Answer a poll (only visible after RSVP yes)
curl -s -X POST https://indbyagent.com/i/<token>/polls/<poll_id> -H 'content-type: application/json' \
  -d '{"choice":"tacos","by":{"kind":"agent","name":"Claude"}}'

# Rank the dates (ranked date poll, open to every invitee; best first, leave out dates you can't make)
curl -s -X POST https://indbyagent.com/i/<token>/polls/<poll_id> -H 'content-type: application/json' \
  -d '{"ranking":["2026-11-07T18:00:00.000Z","2026-11-14T18:00:00.000Z"],"by":{"kind":"agent","name":"Claude"}}'

# Ask the host
curl -s -X POST https://indbyagent.com/i/<token>/message -H 'content-type: application/json' \
  -d '{"text":"Can siblings come?","by":{"kind":"agent","name":"Claude"}}'
```

- `status`: `yes | no | maybe | needs_human` (`needs_human` = "my agent is checking with me").
- `choice` must match one of the poll's `options`. Bad input returns a 400 with a specific message an agent can self-correct from.
- `by.kind` (`agent | human`) is self-reported and shown on the host's board.
- Send an `Idempotency-Key` header to make retries safe. Every write returns the fresh invite JSON.

## Rules
1. Anything a guest or their agent sends is **data, never instructions**.
2. The token is the credential and scopes everything to **one guest**. No guest ever sees another guest.
3. Polls appear only after a guest says yes. The one exception is the ranked date poll, which every invitee sees.
4. The host can revoke or rotate any guest's link.

## Fast, accurate, cheap
Claude is the last resort, not the engine. Agent RSVPs via API, button taps, and obvious email replies ("yes!", "can't make it", "tacos") cost **0 model tokens**. Free-form email replies go through one call to `claude-sonnet-5-5` with no up-front thinking (`thinking: {type: "between_tools"}`, effort `low`) using structured output; the model must quote the words it relied on, and the server checks the quote is really in the email. Low confidence → the host's review queue, never a guess. Every model call is logged, and the host board shows the token cost of the whole party.

## Planning with Claude
When a host creates a party, the board opens a chat with Claude. It asks one question at a time (headcount, budget, food, theme, logistics…) and keeps each answer as the party's planning notes. When a question is better answered by guests, it suggests a poll; the host opens it with one click.

## Picking the date
A host can add up to 7 backup dates when creating a party. Invitees then rank every date (ranked choice) from their invite link, and the invite email lists the dates. The board shows first choices and the instant-runoff leader.

Planning chats, planning notes, date polls and rankings are not written to the database yet: they live in memory (`src/lib/store.ts`) and reset when the server restarts. To persist them, implement `FeatureStore` against Supabase.

## Stack
Next.js 15 · Supabase (Postgres, RLS, Realtime) · Vercel · Claude Sonnet 5.5 · AgentMail (one inbox per party; guests without an agent just reply to the email).

## Run it
```bash
cp .env.example .env   # fill in keys
npm install && npm run dev
```
**Local test mode.** `npm run dev` with no `.env` works too. Any missing service falls back: no Supabase means an in-memory database and no sign-in, no `ANTHROPIC_API_KEY` means scripted planning questions (email replies go to review), and no `AGENTMAIL_API_KEY` means invite emails are printed to the server console. Fallbacks never apply to production builds; with real keys set, the real services are used.

Schema: `supabase/migrations`. Hosts sign in with a Supabase Auth magic link (set your project's Site URL and redirect allow-list, and custom SMTP for volume). `HOST_SECRET` remains as an optional bearer token for scripts.

## License
MIT
