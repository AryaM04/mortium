// Deep links for the AppImage. The deb package installs a desktop file that
// opens "mortium://" links. An AppImage has no desktop file, unless the
// user adds one. Without it, the desktop cannot start the app for a link,
// and the OAuth sign-in cannot finish. Thus the AppImage writes its own
// small desktop file at each start, and makes it the handler of the scheme.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export const LINK_DESKTOP_FILE = "mortium-url-handler.desktop";

/** One argument of an `Exec` line, quoted and escaped as the desktop entry specification says. */
function execArgument(value: string): string {
  const quoted = `"${value.replace(/[\\"`$]/g, (char) => `\\${char}`)}"`;
  return quoted.replace(/\\/g, "\\\\").replace(/%/g, "%%");
}

/** The text of a hidden desktop file that opens `scheme` links with the AppImage at `appImagePath`. */
export function linkDesktopEntry(appImagePath: string, scheme: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Mortium",
    `Exec=${execArgument(appImagePath)} %u`,
    "NoDisplay=true",
    `MimeType=x-scheme-handler/${scheme};`,
    "",
  ].join("\n");
}

/** Write the desktop file for the AppImage, and make it the handler of `scheme` links. */
export async function registerAppImageLinks(appImagePath: string, scheme: string, env: NodeJS.ProcessEnv): Promise<void> {
  const directory = join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "applications");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, LINK_DESKTOP_FILE), linkDesktopEntry(appImagePath, scheme));
  await promisify(execFile)("xdg-mime", ["default", LINK_DESKTOP_FILE, `x-scheme-handler/${scheme}`]);
}
