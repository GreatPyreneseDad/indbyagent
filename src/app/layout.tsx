import type { Metadata } from "next";
import "./globals.css";
import SessionCatch from "./session-catch";

export const metadata: Metadata = {
  title: "IndbyAgent",
  description: "Agent-readable invitations. One link a person can read and an agent can answer.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body><SessionCatch />{children}</body>
    </html>
  );
}
