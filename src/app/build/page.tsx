import type { Metadata } from "next";
import Console from "./console";

export const metadata: Metadata = {
  title: "IndbyAgent for builders",
  description: "Hosted bed planner and carpool matcher APIs for club, cabin-share and trip apps. Open source, free key.",
};

const Code = ({ children }: { children: string }) => (
  <pre className="overflow-x-auto rounded-md border border-neutral-800 bg-neutral-950 p-3 text-xs leading-relaxed text-neutral-300">{children}</pre>
);

export default function Build() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16 space-y-10">
      <header className="space-y-3">
        <div className="text-xs tracking-[.14em] uppercase text-neutral-500">IndbyAgent · for builders</div>
        <h1 className="text-3xl font-semibold">Beds and rides, solved by API</h1>
        <p className="text-neutral-400">Two hosted engines for anyone building a club, cabin-share or trip app. Send your own ids; get plans back. We never see names, emails or addresses. The code is open source (MIT) if you&apos;d rather run it yourself.</p>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Your API key</h2>
        <Console />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Bed planner</h2>
        <p className="text-sm text-neutral-400"><code>POST /api/v1/bed-planner/plan</code>. One call per cabin, after any booking change and daily just after 6pm cabin time. Rules: bigger parties fill beds better (2 × members + guests), priority breaks ties, whoever holds a bed keeps it unless a fuller party needs it, whoever had a nice room most recently yields first, arrival-day picks are sticky, tonight freezes at 6pm, fewest moves, and members who blocked each other never share a room.</p>
        <Code>{`curl https://indbyagent.com/api/v1/bed-planner/plan \\
  -H "Authorization: Bearer $INDBY_KEY" -H "Content-Type: application/json" -d '{
  "rooms": [{ "id": "master", "name": "Master", "premium": 2, "private_bath": true }],
  "beds":  [{ "id": "king", "room_id": "master", "name": "King", "type": "king", "capacity": 2 }],
  "stays": [{ "id": "s1", "member_id": "m1", "check_in": "2026-12-11", "check_out": "2026-12-13",
              "guests": 1, "booked_at": "2026-11-01T00:00:00Z" }],
  "assignments": [], "blocks": []
}'`}</Code>
        <p className="text-sm text-neutral-400">Returns <code>window</code>, <code>assignments</code> (save them, replacing your unlocked rows in the window), <code>moves</code>, <code>unplaced</code> and <code>notices</code> (one per moved member, ready to send). Send your saved assignments back next time, including the night before the window, so people keep their beds. Mark hand-pinned ones <code>locked: true</code>.</p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Carpool matcher</h2>
        <p className="text-sm text-neutral-400"><code>POST /api/v1/carpool/match</code>. One call per event. First come first seated, shortest pickup detour, fill cars already going, respects blocks, seats and departure windows. Use neighborhood names, never addresses; we estimate drive times between neighborhoods you don&apos;t supply (cached per region).</p>
        <Code>{`curl https://indbyagent.com/api/v1/carpool/match \\
  -H "Authorization: Bearer $INDBY_KEY" -H "Content-Type: application/json" -d '{
  "region": "San Francisco Bay Area",
  "offers":   [{ "id": "o1", "driver_id": "d1", "seats_total": 3, "depart_area": "Mission District" }],
  "requests": [{ "id": "r1", "rider_id": "u1", "pickup_area": "Noe Valley" }]
}'`}</Code>
        <p className="text-sm text-neutral-400">Returns <code>matches</code> (proposals; confirm with the driver), <code>unmatched</code> with a reason, and <code>cars</code> with seats left. Pass <code>area_minutes</code> for pairs you know; yours win.</p>
      </section>

      <section className="space-y-2 text-sm text-neutral-400">
        <h2 className="text-lg font-semibold text-neutral-100">Fair use</h2>
        <p>Free while in beta. Up to 3 keys per account, 600 calls per key per hour, and 500 new AI drive-time estimates per account per day. Call from your server only. <code>GET /api/v1/me</code> checks a key. Errors come back as JSON with an <code>error</code> code; 400s include <code>issues</code> naming the bad field.</p>
        <p>We keep a usage log per call (counts, timing, and your member ids one-way hashed so we can count active members). No names, emails, phones or addresses.</p>
      </section>
    </main>
  );
}
