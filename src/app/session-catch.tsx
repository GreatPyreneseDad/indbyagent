"use client";
import { useEffect } from "react";
import { supaBrowser } from "@/lib/supabase-browser";

// A magic link lands with the session in the URL fragment. Parse it ourselves
// and store it explicitly (cookies), then clear the fragment and go to the board.
export default function SessionCatch() {
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.includes("access_token")) return;
    (async () => {
      const supa = supaBrowser();
      const p = new URLSearchParams(hash.slice(1));
      const access_token = p.get("access_token");
      const refresh_token = p.get("refresh_token");
      let ok = false;
      if (access_token && refresh_token) {
        const { error } = await supa.auth.setSession({ access_token, refresh_token });
        ok = !error;
        if (error) console.error("setSession", error.message);
      }
      if (!ok) {
        for (let i = 0; i < 12 && !ok; i++) {
          const { data: { session } } = await supa.auth.getSession();
          ok = !!session;
          if (!ok) await new Promise((r) => setTimeout(r, 250));
        }
      }
      if (ok) {
        window.history.replaceState(null, "", window.location.pathname);
        if (window.location.pathname !== "/host") window.location.assign("/host"); else window.location.reload();
      }
    })();
  }, []);
  return null;
}
