import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Magic-link landing: exchange the code for a session and set the cookies.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/host";
  const res = NextResponse.redirect(new URL(next, url.origin));
  if (!code) return res;
  const supa = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (all) => all.forEach(({ name, value, options }) => res.cookies.set(name, value, options)),
    },
  });
  const { error } = await supa.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(new URL(`/host?error=${encodeURIComponent(error.message)}`, url.origin));
  return res;
}
