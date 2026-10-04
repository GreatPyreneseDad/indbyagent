// Local testing without the owner's services. Each fallback turns on only when
// its keys are missing AND we're not in a production build, so a deploy with
// missing keys fails loudly instead of quietly running on stand-ins.
const dev = process.env.NODE_ENV !== "production";

export const fallback = {
  // In-memory database and an auto-signed-in local host instead of Supabase.
  db: dev && !(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY),
  // Scripted planning questions instead of Claude; email replies go to review.
  claude: dev && !process.env.ANTHROPIC_API_KEY,
  // Invite emails printed to the server console instead of sent.
  mail: dev && !process.env.AGENTMAIL_API_KEY,
  // Venue suggestions kept in memory instead of Neon (see vendors.ts).
  neon: dev && !process.env.NEON_DATABASE_URL,
};
