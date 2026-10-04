import { randomUUID } from "node:crypto";

// In-memory stand-in for the Supabase client, used only for local testing when
// Supabase isn't configured (see db.ts). Implements just the query-builder calls
// this app makes, plus the guest_state/poll_state views. Data is lost on restart.

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string; code?: string } | null; count?: number | null };

const DEFAULTS: Record<string, Row> = {
  hosts: {},
  parties: { timezone: "America/Los_Angeles", kind: null, ends_at: null, location: null, details: null, rsvp_by: null, inbox_address: null, join_token_hash: null, join_enabled: true, join_max: 300 },
  guests: { email: null, phone: null, party_size_max: 1, token_revoked_at: null, self_joined: false },
  rsvps: { party_size: null, dietary: [], note: null, by_name: null, idempotency_key: null },
  polls: { closes_at: null, status: "open", kind: "preference" },
  poll_answers: { note: null, by_name: null, idempotency_key: null, ranking: null },
  planning_messages: {},
  planning_notes: { notes: {} },
  messages: { guest_id: null, by_name: null },
  review_queue: { guest_id: null, parse: null, resolved_at: null },
  llm_calls: { effort: null, input_tokens: 0, cache_read_tokens: 0, output_tokens: 0, ms: null },
};
const UNIQUE: Record<string, string[][]> = {
  hosts: [["auth_user_id"]],
  parties: [["slug"], ["join_token_hash"]],
  guests: [["token_hash"]],
  rsvps: [["guest_id", "idempotency_key"]],
  poll_answers: [["poll_id", "guest_id", "idempotency_key"]],
  planning_notes: [["party_id"]],
};

type Tables = Record<string, Row[]>;
const g = globalThis as typeof globalThis & { __indbyagentLocalDb?: { tables: Tables; lastTs: number } };
const mem = (g.__indbyagentLocalDb ??= { tables: Object.fromEntries(Object.keys(DEFAULTS).map((t) => [t, []])), lastTs: 0 });

// Strictly increasing timestamps so "latest row wins" is well defined.
function now() {
  mem.lastTs = Math.max(Date.now(), mem.lastTs + 1);
  return new Date(mem.lastTs).toISOString();
}

const latestBy = <T extends Row>(rows: T[]) => [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];

function view(name: string): Row[] {
  const t = mem.tables;
  if (name === "guest_state") {
    return t.guests.map((gst) => {
      const r = latestBy(t.rsvps.filter((x) => x.guest_id === gst.id));
      return {
        guest_id: gst.id, party_id: gst.party_id, name: gst.name, email: gst.email, party_size_max: gst.party_size_max,
        status: r?.status ?? null, party_size: r?.party_size ?? null, dietary: r?.dietary ?? null, note: r?.note ?? null,
        by_kind: r?.by_kind ?? null, by_name: r?.by_name ?? null, channel: r?.channel ?? null, answered_at: r?.created_at ?? null,
      };
    });
  }
  if (name === "poll_state") {
    return t.polls.flatMap((p) => {
      const byGuest = new Map<unknown, Row>();
      for (const a of t.poll_answers.filter((x) => x.poll_id === p.id)) {
        const cur = byGuest.get(a.guest_id);
        if (!cur || String(a.created_at) > String(cur.created_at)) byGuest.set(a.guest_id, a);
      }
      const base = { poll_id: p.id, party_id: p.party_id, question: p.question, options: p.options, status: p.status, closes_at: p.closes_at, kind: p.kind };
      const empty = { guest_id: null, choice: null, ranking: null, note: null, by_kind: null, by_name: null, channel: null, answered_at: null };
      if (!byGuest.size) return [{ ...base, ...empty }];
      return [...byGuest.values()].map((a) => ({ ...base, guest_id: a.guest_id, choice: a.choice, ranking: a.ranking, note: a.note, by_kind: a.by_kind, by_name: a.by_name, channel: a.channel, answered_at: a.created_at }));
    });
  }
  const rows = t[name];
  if (!rows) throw new Error(`local db: unknown table ${name}`);
  return rows;
}

const likeToRegex = (pattern: string, flags: string) =>
  new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".")}$`, flags);

class Query implements PromiseLike<Result> {
  private filters: ((r: Row) => boolean)[] = [];
  private sorts: { col: string; asc: boolean }[] = [];
  private max?: number;
  private cols = "*";
  private returning = false;
  private countMode = false;
  private headOnly = false;
  private cardinality: "many" | "single" | "maybe" = "many";
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private payload: Row[] | Row = [];

  constructor(private table: string) {}

  select(cols = "*", opts?: { count?: string; head?: boolean }) {
    this.cols = cols;
    if (this.op === "select") { this.countMode = !!opts?.count; this.headOnly = !!opts?.head; } else this.returning = true;
    return this;
  }
  insert(rows: Row | Row[]) { this.op = "insert"; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  update(patch: Row) { this.op = "update"; this.payload = patch; return this; }
  upsert(row: Row) { this.op = "upsert"; this.payload = row; return this; }
  delete() { this.op = "delete"; return this; }
  eq(col: string, v: unknown) { this.filters.push((r) => r[col] === v); return this; }
  in(col: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[col])); return this; }
  like(col: string, p: string) { const re = likeToRegex(p, "s"); this.filters.push((r) => re.test(String(r[col] ?? ""))); return this; }
  ilike(col: string, p: string) { const re = likeToRegex(p, "is"); this.filters.push((r) => re.test(String(r[col] ?? ""))); return this; }
  not(col: string, op: string, v: unknown) {
    if (op !== "is" || v !== null) throw new Error(`local db: unsupported not(${op})`);
    this.filters.push((r) => r[col] != null);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) { this.sorts.push({ col, asc: opts?.ascending ?? true }); return this; }
  limit(n: number) { this.max = n; return this; }
  single() { this.cardinality = "single"; return this; }
  maybeSingle() { this.cardinality = "maybe"; return this; }

  then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, fail?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve().then(() => this.run()).then(ok, fail);
  }

  private project(r: Row): Row {
    if (this.cols.trim() === "*") return structuredClone(r);
    return Object.fromEntries(this.cols.split(",").map((c) => c.trim()).filter(Boolean).map((c) => [c, structuredClone(r[c] ?? null)]));
  }

  private shape(rows: Row[]): Result {
    const out = rows.map((r) => this.project(r));
    if (this.cardinality === "many") return { data: out, error: null };
    if (out.length === 1) return { data: out[0], error: null };
    if (out.length === 0 && this.cardinality === "maybe") return { data: null, error: null };
    return { data: null, error: { message: `expected one row, got ${out.length}`, code: "PGRST116" } };
  }

  private run(): Result {
    if (this.op === "insert") {
      const rows = mem.tables[this.table];
      if (!rows) return { data: null, error: { message: `local db: cannot insert into ${this.table}` } };
      const made: Row[] = [];
      for (const input of this.payload as Row[]) {
        const row: Row = { id: randomUUID(), created_at: now(), ...DEFAULTS[this.table], ...structuredClone(input) };
        for (const key of UNIQUE[this.table] ?? []) {
          if (key.some((k) => row[k] == null)) continue;
          if ([...rows, ...made].some((r) => key.every((k) => r[k] === row[k]))) {
            return { data: null, error: { message: `duplicate key value violates unique constraint (${key.join(",")})`, code: "23505" } };
          }
        }
        made.push(row);
      }
      rows.push(...made);
      return this.returning ? this.shape(made) : { data: null, error: null };
    }
    if (this.op === "upsert") {
      const rows = mem.tables[this.table];
      const input = this.payload as Row;
      const key = (UNIQUE[this.table] ?? [["id"]])[0];
      const existing = rows.find((r) => key.every((k) => r[k] === input[k]));
      if (existing) Object.assign(existing, structuredClone(input));
      else rows.push({ id: randomUUID(), created_at: now(), ...DEFAULTS[this.table], ...structuredClone(input) });
      return { data: null, error: null };
    }
    let rows = view(this.table).filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "delete") {
      const t = mem.tables[this.table];
      mem.tables[this.table] = t.filter((r) => !rows.includes(r));
      return { data: null, error: null };
    }
    if (this.op === "update") {
      rows.forEach((r) => Object.assign(r, structuredClone(this.payload as Row)));
      return this.returning ? this.shape(rows) : { data: null, error: null };
    }
    for (const s of [...this.sorts].reverse()) {
      rows = [...rows].sort((a, b) => {
        const x = a[s.col], y = b[s.col];
        const c = x == null && y == null ? 0 : x == null ? 1 : y == null ? -1 : String(x).localeCompare(String(y), undefined, { numeric: true });
        return s.asc ? c : -c;
      });
    }
    if (this.max != null) rows = rows.slice(0, this.max);
    if (this.headOnly) return { data: null, error: null, count: rows.length };
    const res = this.shape(rows);
    return this.countMode ? { ...res, count: rows.length } : res;
  }
}

export const localDb = { from: (table: string) => new Query(table) };
