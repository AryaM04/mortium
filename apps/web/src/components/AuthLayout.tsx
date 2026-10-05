// A centered card layout shared by every auth page (login, register,
// forgot password, and so on), the download page and the security gate.
// The card sits on the canvas, with a faint accent glow and the wordmark.
import type { ReactNode } from "react";

export function Wordmark() {
  return (
    <div className="mb-6 flex items-center justify-center gap-2 text-primary" aria-hidden="true">
      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-sm font-bold text-on-accent">
        M
      </span>
      <span className="text-lg font-semibold tracking-tight">Mortium</span>
    </div>
  );
}

/** The page behind a centered card. `wide` gives a wider card. */
export function CardPage({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <main
      className="flex h-full w-full justify-center overflow-y-auto bg-canvas p-4"
      style={{
        backgroundImage:
          "radial-gradient(ellipse 60% 45% at 50% 0%, rgba(45, 212, 191, 0.10), transparent 70%)",
      }}
    >
      <div className={`my-auto w-full py-8 ${wide ? "max-w-lg" : "max-w-sm"}`}>
        <Wordmark />
        <div className="card p-6 shadow-[var(--shadow-large)]">{children}</div>
      </div>
    </main>
  );
}

export function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <CardPage>
      <h1 className="mb-5 text-xl font-semibold tracking-tight">{title}</h1>
      {children}
    </CardPage>
  );
}
