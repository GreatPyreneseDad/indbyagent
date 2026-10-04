"use client";
import { useEffect } from "react";
import { supaBrowser } from "@/lib/supabase-browser";

// If a magic link lands anywhere with a session in the URL fragment (implicit
// flow), let supabase-js store it, then go to the host board.
export default function SessionCatch() {
  useEffect(() => {
    if (!window.location.hash.includes("access_token")) return;
    const supa = supaBrowser();
    const { data: sub } = supa.auth.onAuthStateChange((evt, session) => {
      if (!session) return;
      sub.subscription.unsubscribe();
      window.history.replaceState(null, "", window.location.pathname);
      if (window.location.pathname !== "/host") window.location.assign("/host");
      else window.location.reload();
    });
  }, []);
  return null;
}
