"use client";
import { createBrowserClient } from "@supabase/ssr";
// Implicit flow: the magic link returns tokens in the URL fragment, which
// works no matter which browser or device opens the email.
export const supaBrowser = () =>
  createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { flowType: "implicit", detectSessionInUrl: true },
  });
