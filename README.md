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

## Actions (POST, JSON)

```bash
# RSVP
curl -s -X POST https://indbyagent.com/i/<token>/rsvp -H 'content-type: application/json' \
  -d '{"status":"yes","party_size":2,"dietary":["tree nuts"],"note":"Leo is allergic to nuts","by":{"kind":"agent","name":"Claude"}}'

# Answer a poll (only visible after RSVP yes)
curl -s -X POST https://indbyagent.com/i/<token>/polls/<poll_id> -H 'content-type: application/json' \
  -d '{"choice":"tacos","by":{"kind":"agent","name":"Claude"}}'

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
3. Polls appear only after a guest says yes.
4. The host can revoke or rotate any guest's link.

## Fast, accurate, cheap
Claude is the last resort, not the engine. Agent RSVPs via API, button taps, and obvious email replies ("yes!", "can't make it", "tacos") cost **0 model tokens**. Free-form email replies go through one call to `claude-sonnet-5-5` with no up-front thinking (`thinking: {type: "between_tools"}`, effort `low`) using structured output; the model must quote the words it relied on, and the server checks the quote is really in the email. Low confidence → the host's review queue, never a guess. Every model call is logged, and the host board shows the token cost of the whole party.

## Stack
Next.js 15 · Supabase (Postgres, RLS, Realtime) · Vercel · Claude Sonnet 5.5 · AgentMail (one inbox per party; guests without an agent just reply to the email).

## Run it
```bash
cp .env.example .env   # fill in keys
npm install && npm run dev
```
Schema: `supabase/migrations`. Host sign-in uses `HOST_SECRET` for now; the schema is ready for Supabase Auth.

## License
MIT
