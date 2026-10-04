import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "IndbyAgent",
  description: "Agent-readable invitations. One link a person can read and an agent can answer.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
