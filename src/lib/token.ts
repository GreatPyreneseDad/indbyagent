import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Guest tokens: 160 random bits, base64url. Stored hashed (sha256) so a DB
// leak doesn't leak invite links. The token itself is the guest's credential.
export function newToken(): string {
  return randomBytes(20).toString("base64url");
}
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
export function looksLikeToken(t: string): boolean {
  return /^[A-Za-z0-9_-]{20,40}$/.test(t);
}
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function siteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000")
  );
}
export function inviteUrl(token: string): string {
  return `${siteUrl()}/i/${token}`;
}
