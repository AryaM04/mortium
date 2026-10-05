// Dev-only media diagnostics panel.
//
// This panel checks the WebRTC and media capture APIs before real voice
// and video code exists (see M0, spike b in the plan). It loads only when
// the page URL has a "diag" query flag, and only in a dev build. Keep this
// file small; App.tsx loads it with a lazy import so it never adds to the
// normal app bundle.

import { useState } from "react";

interface CheckResult {
  kind: string;
  label: string;
  settings: string;
}

type RunState = CheckResult | string | null;

async function runMediaCheck(getStream: () => Promise<MediaStream>): Promise<CheckResult> {
  const stream = await getStream();
  const track = stream.getTracks()[0];
  if (!track) {
    throw new Error("The stream had no track.");
  }
  const result: CheckResult = {
    kind: track.kind,
    label: track.label || "(the device gave no label)",
    settings: JSON.stringify(track.getSettings()),
  };
  // Stop every track now. We only needed the track information above.
  for (const t of stream.getTracks()) {
    t.stop();
  }
  return result;
}

function ApiRow({ name, present }: { name: string; present: boolean }) {
  return (
    <li>
      {name}: <strong>{present ? "present" : "not present"}</strong>
    </li>
  );
}

function TestButton({ name, onRun }: { name: string; onRun: () => Promise<CheckResult> }) {
  const [state, setState] = useState<RunState>(null);
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    setBusy(true);
    setState(null);
    try {
      setState(await onRun());
    } catch (err) {
      setState(err instanceof Error ? err.message : "The test failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginBottom: "0.75rem" }}>
      <button onClick={handleClick} disabled={busy}>
        {busy ? "Testing..." : name}
      </button>
      {typeof state === "string" && (
        <p style={{ color: "var(--color-danger-text)" }}>Error: {state}</p>
      )}
      {state !== null && typeof state !== "string" && (
        <p>
          Track kind: {state.kind}. Label: {state.label}. Settings: {state.settings}
        </p>
      )}
    </div>
  );
}

export default function DiagPanel() {
  const hasPeerConnection = typeof RTCPeerConnection !== "undefined";
  const hasGetUserMedia = Boolean(navigator.mediaDevices?.getUserMedia);
  const hasGetDisplayMedia = Boolean(navigator.mediaDevices?.getDisplayMedia);

  return (
    <div
      style={{
        position: "fixed",
        bottom: "1rem",
        right: "1rem",
        maxWidth: "24rem",
        padding: "1rem",
        background: "var(--color-elevated)",
        color: "var(--color-primary)",
        border: "1px solid var(--color-line-strong)",
        borderRadius: "0.5rem",
        fontSize: "0.85rem",
        zIndex: 9999,
      }}
    >
      <h2 style={{ marginTop: 0 }}>Media diagnostics</h2>
      <ul>
        <ApiRow name="RTCPeerConnection" present={hasPeerConnection} />
        <ApiRow name="getUserMedia" present={hasGetUserMedia} />
        <ApiRow name="getDisplayMedia" present={hasGetDisplayMedia} />
      </ul>
      <TestButton
        name="Test microphone"
        onRun={() => runMediaCheck(() => navigator.mediaDevices.getUserMedia({ audio: true }))}
      />
      <TestButton
        name="Test camera"
        onRun={() => runMediaCheck(() => navigator.mediaDevices.getUserMedia({ video: true }))}
      />
      <TestButton
        name="Test screen share"
        onRun={() => runMediaCheck(() => navigator.mediaDevices.getDisplayMedia({ video: true }))}
      />
    </div>
  );
}
