import { NextRequest, NextResponse } from "next/server";
import { unauthorized, forbidden } from "@/lib/host";
import { currentHost, hostOwnsParty } from "@/lib/auth";
import { settle } from "@/lib/payments";

export const dynamic = "force-dynamic";

// PATCH: the host marks an offline (manual-provider) payment as settled.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; attemptId: string }> }) {
  const host = await currentHost(req);
  if (!host) return unauthorized();
  const { id, attemptId } = await params;
  if (!(await hostOwnsParty(host, id))) return forbidden();
  const t = await settle(id, host.id, attemptId);
  if ("error" in t) return NextResponse.json(t, { status: 409 });
  return NextResponse.json({ attempt: t });
}
