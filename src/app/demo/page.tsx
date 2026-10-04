import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "IndbyAgent demo",
  description: "82 seconds: a QR invite, a human RSVP, an agent RSVP over the API, an email reply parsed by Claude, and the host board. All live.",
  openGraph: { images: ["/demo/poster.png"], videos: ["/demo/indbyagent-demo.mp4"] },
};

export default function Demo() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-14 space-y-6">
      <a href="/" className="text-xs tracking-[.14em] uppercase text-neutral-500">IndbyAgent</a>
      <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Every invite is a link a person can read and an agent can answer.</h1>
      <video src="/demo/indbyagent-demo.mp4" poster="/demo/poster.png" controls playsInline preload="metadata" className="w-full aspect-video rounded-lg border border-neutral-800 bg-black" />
      <p className="text-neutral-400 max-w-prose">
        Everything in this recording ran against the live system: the QR screen filling up, a guest joining from a phone, an agent joining and RSVPing over the API
        with zero model tokens, Grandma&apos;s plain-English email parsed by Claude Sonnet 5.5 with thinking off, and the host board that shows who answered and what it cost.
      </p>
      <div className="flex flex-wrap gap-3 text-sm">
        <a className="rounded-md bg-white text-neutral-900 px-4 py-2 font-medium" href="/host">Host a party</a>
        <a className="rounded-md border border-neutral-700 px-4 py-2" href="https://github.com/GreatPyreneseDad/indbyagent">Source &amp; spec</a>
      </div>
    </main>
  );
}
