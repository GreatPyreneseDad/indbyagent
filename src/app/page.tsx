import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-24 space-y-8">
      <div className="text-xs tracking-[.14em] uppercase text-neutral-500">IndbyAgent · v0.1</div>
      <h1 className="text-4xl sm:text-5xl font-bold tracking-tight leading-[1.05]">
        Every invite is a link a person can read and an agent can answer.
      </h1>
      <p className="text-neutral-400 max-w-prose">
        A guest opens the link and sees the party. A guest&apos;s agent opens the same link and gets structured JSON, with the exact
        calls to RSVP, answer polls and message the host. No form, no login, no human in the loop unless one is needed.
      </p>
      <pre className="text-sm bg-neutral-900 border border-neutral-800 rounded-lg p-4 overflow-x-auto">{`curl -s https://indbyagent.com/i/<token>.json
curl -s -X POST https://indbyagent.com/i/<token>/rsvp \\
  -H 'content-type: application/json' \\
  -d '{"status":"yes","party_size":2,"dietary":["tree nuts"],"by":{"kind":"agent","name":"Claude"}}'`}</pre>
      <div className="flex gap-3">
        <Link href="/host" className="rounded-md bg-white text-neutral-900 px-5 py-2.5 font-medium">Host a party</Link>
        <a href="https://github.com/GreatPyreneseDad/indbyagent" className="rounded-md border border-neutral-700 px-5 py-2.5">Spec &amp; source</a>
      </div>
    </main>
  );
}
