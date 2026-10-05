import { NextRequest, NextResponse } from "next/server";
import { db, type Party } from "./db";
import { loadRequestByToken, requestJson, type RequestCtx } from "./vendor-requests";

export const loadParty = async (id: string) => ((await db.from("parties").select("*").eq("id", id).single()).data as Party | null);
export const loadCtx = (token: string) => loadRequestByToken(token, loadParty);

// Every vendor write returns the fresh request document.
export async function respondWithRequest(token: string, status = 200) {
  const ctx = (await loadCtx(token)) as RequestCtx;
  return NextResponse.json(requestJson(ctx, token), { status, headers: { "cache-control": "no-store" } });
}

export const isForm = (req: NextRequest) => (req.headers.get("content-type") ?? "").includes("form");
