// The global push-to-talk key of the Linux app. On X11, uiohook-napi reads
// the key down and key up events of the whole desktop session, also while
// the window has no focus. It does not take the key from other apps.
//
// Wayland does not let an app read the keys of other apps. The
// GlobalShortcuts portal (Electron globalShortcut with the
// GlobalShortcutsPortal feature) reports only the key press, not the
// release, so it cannot drive a hold-to-talk key. On Wayland the app
// therefore gives the reason below, and push to talk works only while the
// window has focus.
//
// The hook runs only while a call in push-to-talk mode needs it.

export const PUSH_TO_TALK_UNAVAILABLE = "Global push to talk is not available on this desktop session.";

/** Null when a global key is possible in this session, else the reason. */
export function pushToTalkUnavailableReason(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
  if (platform === "linux") {
    const session = env.XDG_SESSION_TYPE;
    if (session === "wayland" || (session === undefined && env.WAYLAND_DISPLAY)) {
      return PUSH_TO_TALK_UNAVAILABLE;
    }
    if (!env.DISPLAY) {
      return PUSH_TO_TALK_UNAVAILABLE;
    }
  }
  return null;
}

/** The uiohook key codes of `KeyboardEvent.code` values that are not a letter, a digit or a function key. */
const NAMED_KEYS: Record<string, number> = {
  Backspace: 14,
  Tab: 15,
  Enter: 28,
  CapsLock: 58,
  Escape: 1,
  Space: 57,
  PageUp: 3657,
  PageDown: 3665,
  End: 3663,
  Home: 3655,
  ArrowLeft: 57419,
  ArrowUp: 57416,
  ArrowRight: 57421,
  ArrowDown: 57424,
  Insert: 3666,
  Delete: 3667,
  Numpad0: 82,
  Numpad1: 79,
  Numpad2: 80,
  Numpad3: 81,
  Numpad4: 75,
  Numpad5: 76,
  Numpad6: 77,
  Numpad7: 71,
  Numpad8: 72,
  Numpad9: 73,
  NumpadMultiply: 55,
  NumpadAdd: 78,
  NumpadSubtract: 74,
  NumpadDecimal: 83,
  NumpadDivide: 3637,
  Semicolon: 39,
  Equal: 13,
  Comma: 51,
  Minus: 12,
  Period: 52,
  Slash: 53,
  Backquote: 41,
  BracketLeft: 26,
  Backslash: 43,
  BracketRight: 27,
  Quote: 40,
  NumLock: 69,
  ScrollLock: 70,
  PrintScreen: 3639,
};

const LETTER_KEYS = "QWERTYUIOP ASDFGHJKL ZXCVBNM";
/** Letter key codes in keyboard row order (Q=16 ... P=25, A=30 ... L=38, Z=44 ... M=50). */
const LETTER_ROW_START = [16, 30, 44];
const DIGIT_KEYS: Record<string, number> = { 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 0: 11 };
const FUNCTION_KEYS = [59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88, 91, 92, 93, 99, 100, 101, 102, 103, 104, 105, 106, 107];

/** The uiohook key code for a `KeyboardEvent.code` value, or null for a key that the hook does not know. */
export function keyCodeOf(code: string): number | null {
  if (/^Key[A-Z]$/.test(code)) {
    const letter = code.slice(3);
    const rows = LETTER_KEYS.split(" ");
    for (const [index, row] of rows.entries()) {
      const position = row.indexOf(letter);
      if (position >= 0) {
        return LETTER_ROW_START[index]! + position;
      }
    }
  }
  if (/^Digit[0-9]$/.test(code)) {
    return DIGIT_KEYS[code.slice(5)]!;
  }
  const functionKey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (functionKey) {
    return FUNCTION_KEYS[Number(functionKey[1]) - 1]!;
  }
  return NAMED_KEYS[code] ?? null;
}

export interface Shortcut {
  keyCode: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** Read a shortcut such as "Control+Shift+KeyT" (the format of the web app). Throws for a shortcut that is not valid. */
export function parseShortcut(shortcut: string): Shortcut {
  const parts = shortcut.split("+");
  const code = parts.pop() ?? "";
  const keyCode = keyCodeOf(code);
  const known = new Set(["Control", "Alt", "Shift", "Super"]);
  if (keyCode === null || parts.some((part) => !known.has(part)) || new Set(parts).size !== parts.length) {
    throw new Error("The app cannot use this key for push to talk. Pick another key.");
  }
  return {
    keyCode,
    ctrlKey: parts.includes("Control"),
    altKey: parts.includes("Alt"),
    shiftKey: parts.includes("Shift"),
    metaKey: parts.includes("Super"),
  };
}

export interface KeyEvent {
  keycode: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** The part of uiohook-napi that this file uses. A test supplies a fake. */
export interface KeyHook {
  on(event: "keydown" | "keyup", listener: (event: KeyEvent) => void): unknown;
  removeListener(event: "keydown" | "keyup", listener: (event: KeyEvent) => void): unknown;
  start(): void;
  stop(): void;
}

/**
 * One global push-to-talk key. `onChange(true)` on key down with the
 * modifiers held, `onChange(false)` on key up. Key repeat sends nothing.
 */
export class GlobalPushToTalk {
  private stopCurrent: (() => void) | null = null;
  /** Counts the `set` calls. A call that a later call replaced while it waited does nothing. */
  private generation = 0;

  constructor(
    private readonly loadHook: () => Promise<KeyHook>,
    private readonly onChange: (pressed: boolean) => void,
  ) {}

  /** Use this shortcut, or no shortcut (null). Rejects when the key is not valid or the hook does not start. */
  async set(shortcut: string | null): Promise<void> {
    const generation = ++this.generation;
    this.stopCurrent?.();
    this.stopCurrent = null;
    if (shortcut === null) {
      return;
    }
    const target = parseShortcut(shortcut);
    let hook: KeyHook;
    try {
      hook = await this.loadHook();
    } catch {
      throw new Error(PUSH_TO_TALK_UNAVAILABLE);
    }
    if (generation !== this.generation) {
      return;
    }
    let pressed = false;
    const down = (event: KeyEvent) => {
      const modifiersHeld =
        (!target.ctrlKey || event.ctrlKey) &&
        (!target.altKey || event.altKey) &&
        (!target.shiftKey || event.shiftKey) &&
        (!target.metaKey || event.metaKey);
      if (event.keycode === target.keyCode && modifiersHeld && !pressed) {
        pressed = true;
        this.onChange(true);
      }
    };
    const up = (event: KeyEvent) => {
      if (event.keycode === target.keyCode && pressed) {
        pressed = false;
        this.onChange(false);
      }
    };
    hook.on("keydown", down);
    hook.on("keyup", up);
    try {
      hook.start();
    } catch {
      hook.removeListener("keydown", down);
      hook.removeListener("keyup", up);
      throw new Error(PUSH_TO_TALK_UNAVAILABLE);
    }
    this.stopCurrent = () => {
      hook.removeListener("keydown", down);
      hook.removeListener("keyup", up);
      hook.stop();
      if (pressed) {
        pressed = false;
        this.onChange(false);
      }
    };
  }
}
