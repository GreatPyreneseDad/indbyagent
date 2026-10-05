import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { fallback } from "./fallback";

// The Neon connection, shared by the modules that keep vendor-side data there
// (vendors.ts, vendor-requests.ts, payments.ts). Nothing guest-facing imports
// these. Created lazily so a missing NEON_DATABASE_URL only fails the vendor
// routes, never the invite paths.
export function sql(): NeonQueryFunction<false, false> {
  const url = process.env.NEON_DATABASE_URL;
  if (!url) throw new Error("NEON_DATABASE_URL is not set; vendor features need the Neon database");
  return neon(url);
}

export const neonFallback = () => fallback.neon;

// In local test mode (no NEON_DATABASE_URL, not production): tiny in-memory
// tables so `npm run dev` with no .env still exercises the vendor routes.
type Row = Record<string, unknown>;
const g = globalThis as typeof globalThis & { __indbyagentNeonMem?: Record<string, Row[]> };
export const mem = (g.__indbyagentNeonMem ??= {});
export function table<T extends Row>(name: string): T[] { return (mem[name] ??= []) as T[]; }
