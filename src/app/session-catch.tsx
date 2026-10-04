"use client";
import { useEffect } from "react";
import { supaBrowser } from "@/lib/supabase-browser";

// A magic link lands with the session in the URL fragment. supabase-js stores
// it on init; once that's done, clear the fragment and go to the board.
export default function SessionCatch() {
  useEffect(() => {
    if (!window.location.hash.includes("access_token")) return;
    (async () => {
      const supa = supaBrowser();
      for (let i = 0; i < 20; i++) {
        const { data: { session } } = await supa.auth.getSession();
        if (session) {
          window.history.replaceState(null, "", window.location.pathname);
          if (window.location.pathname !== "/host") window.location.assign("/host"); else window.location.reload();
          return;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
  }, []);
  return null;
}
