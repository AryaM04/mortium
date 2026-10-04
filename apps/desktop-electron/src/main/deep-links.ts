// Deep links, such as "mortium://invite/abc" or
// "mortium://auth/callback#code=x". On Linux, the desktop file of the
// app starts it with the link as an argument. A second start gives its
// arguments to the running app (the single instance lock). A link can
// arrive before the web app listens, so links wait in a buffer until the
// web app calls `init`.

const MAX_LINK_LENGTH = 2048;
const MAX_LINKS = 10;

/** The deep links in a list of command line arguments. */
export function deepLinksIn(argv: readonly string[], scheme: string): string[] {
  const prefix = `${scheme}://`;
  return argv
    .filter((arg) => arg.length <= MAX_LINK_LENGTH && arg.toLowerCase().startsWith(prefix))
    .slice(0, MAX_LINKS);
}

/** Links that wait for the web app. */
export class PendingLinks {
  private waiting: string[] | null = [];

  constructor(private readonly send: (links: string[]) => void) {}

  add(links: string[]): void {
    if (links.length === 0) {
      return;
    }
    if (this.waiting) {
      this.waiting.push(...links);
      this.waiting.splice(0, Math.max(0, this.waiting.length - MAX_LINKS));
    } else {
      this.send(links);
    }
  }

  /** Keep new links in the buffer again. Call this when the page loads again, before it listens. */
  hold(): void {
    this.waiting ??= [];
  }

  /** Give the waiting links to the web app. After this, new links go out at once. */
  take(): string[] {
    const links = this.waiting ?? [];
    this.waiting = null;
    return links;
  }
}
