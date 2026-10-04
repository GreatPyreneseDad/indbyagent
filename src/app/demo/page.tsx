import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "IndbyAgent demo",
  description: "Two minutes, the whole build on the live site: magic-link sign-in, a party with candidate dates, planning with Claude, the venue agent, invites and a QR, guests and their agents answering, an email reply parsed by Claude, and the date picked with one click.",
  openGraph: { images: ["/demo/poster.png"], videos: ["/demo/indbyagent-demo.mp4"] },
};

export default function Demo() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-14 space-y-6">
      <a href="/" className="text-xs tracking-[.14em] uppercase text-neutral-500">IndbyAgent</a>
      <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Every invite is a link a person can read and an agent can answer.</h1>
      <video src="/demo/indbyagent-demo.mp4" poster="/demo/poster.png" controls playsInline preload="metadata" className="w-full aspect-video rounded-lg border border-neutral-800 bg-black" />
      <p className="text-neutral-400 max-w-prose">
        Everything in this recording ran against the live system, start to finish: a magic-link sign-in, a party with two candidate dates, Claude planning one question at a time,
        the venue agent searching the web and the host confirming, invites and a QR, guests and their agents answering the same link, Grandma&apos;s plain-English email parsed by
        Claude Sonnet 5.5 with thinking off, and the date picked with one click. The captions estimate what each step usually costs a host: about six hours of an evening, done in four minutes.
      </p>
      <div className="flex flex-wrap gap-3 text-sm">
        <a className="rounded-md bg-white text-neutral-900 px-4 py-2 font-medium" href="/host">Host a party</a>
        <a className="rounded-md border border-neutral-700 px-4 py-2" href="https://github.com/GreatPyreneseDad/indbyagent">Source &amp; spec</a>
      </div>
    </main>
  );
}
