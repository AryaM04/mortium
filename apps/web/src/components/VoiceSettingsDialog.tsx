// The "Voice and video" settings dialog: input/output/camera device
// choice, input mode (voice activity or push to talk), a mic test level
// meter, and a mirrored camera preview. Loaded with a dynamic import only
// while it is open (see `VoiceSettingsDialogLoader.tsx`), per CLAUDE.md's
// rule to load heavy UI only when it is needed.
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import {
  applyCameraDeviceLive,
  applyInputDeviceLive,
  applyOutputDeviceLive,
  applyVoiceInputMode,
} from "../lib/voice.js";
import { describeKeyCode, shortcutFromEvent } from "../lib/ptt.js";
import { desktopFeatures } from "../lib/platform.js";
import { updateVoiceDeviceSettings, voiceDeviceSettingsStore, type VoiceInputMode } from "../lib/voice-settings.js";

// The Audio Output Devices API adds `setSinkId` to `AudioContext`, not yet
// in TypeScript's DOM lib. Feature-detect it the same way the engine
// checks the `<audio>` element's own `setSinkId` in `engine.ts`.
interface AudioContextWithSinkId {
  setSinkId?(deviceId: string): Promise<void>;
}

const outputDeviceSelectSupported =
  typeof AudioContext !== "undefined" &&
  Boolean((AudioContext.prototype as unknown as AudioContextWithSinkId).setSinkId) ||
  (typeof HTMLMediaElement !== "undefined" && Boolean((HTMLMediaElement.prototype as unknown as AudioContextWithSinkId).setSinkId));

interface DeviceLists {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
  labelsKnown: boolean;
}

async function loadDevices(): Promise<DeviceLists> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === "audioinput");
  const outputs = devices.filter((d) => d.kind === "audiooutput");
  const cameras = devices.filter((d) => d.kind === "videoinput");
  const labelsKnown = inputs.length === 0 || inputs.every((d) => d.label !== "");
  return { inputs, outputs, cameras, labelsKnown };
}

export function VoiceSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const settings = useStore(voiceDeviceSettingsStore);
  const [devices, setDevices] = useState<DeviceLists>({ inputs: [], outputs: [], cameras: [], labelsKnown: true });
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [capturingKey, setCapturingKey] = useState(false);

  // Mic test state.
  const [micTestOn, setMicTestOn] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const micStreamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  // Camera preview state.
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      void refreshDevices();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  async function refreshDevices(): Promise<void> {
    try {
      setDevices(await loadDevices());
    } catch {
      // enumerateDevices itself rarely throws; leave the lists as they were.
    }
  }

  async function requestMicPermission(): Promise<void> {
    setPermissionError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) {
        track.stop();
      }
      await refreshDevices();
    } catch {
      setPermissionError("The browser did not allow use of the microphone.");
    }
  }

  // Camera preview: start while the dialog is open, stop on close.
  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    let stream: MediaStream | null = null;
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: settings.cameraDeviceId ? { deviceId: settings.cameraDeviceId } : true,
        });
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        setCameraStream(stream);
      } catch {
        // No camera, or permission denied: the preview just stays empty.
      }
    })();
    return () => {
      cancelled = true;
      setCameraStream(null);
      if (stream) {
        for (const track of stream.getTracks()) track.stop();
      }
    };
  }, [open, settings.cameraDeviceId]);

  useEffect(() => {
    const el = cameraVideoRef.current;
    if (!el) return;
    el.srcObject = cameraStream;
    return () => {
      el.srcObject = null;
    };
  }, [cameraStream]);

  // Mic test: one rAF loop, only while the dialog is open and the test is on.
  useEffect(() => {
    if (!open || !micTestOn) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: settings.inputDeviceId ? { deviceId: settings.inputDeviceId } : true,
        });
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        micStreamRef.current = stream;
        const audioContext = new AudioContext();
        audioContextRef.current = audioContext;
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        analyserRef.current = analyser;
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteFrequencyData(data);
          let sum = 0;
          for (const value of data) sum += value;
          setMicLevel(Math.min(1, sum / data.length / 128));
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        setMicTestOn(false);
        setPermissionError("The browser did not allow use of the microphone.");
      }
    })();
    return () => {
      cancelled = true;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      analyserRef.current = null;
      if (audioContextRef.current) {
        void audioContextRef.current.close();
        audioContextRef.current = null;
      }
      if (micStreamRef.current) {
        for (const track of micStreamRef.current.getTracks()) track.stop();
        micStreamRef.current = null;
      }
      setMicLevel(0);
    };
  }, [open, micTestOn, settings.inputDeviceId]);

  useEffect(() => {
    if (!capturingKey) return;
    function onKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      if (event.key === "Escape") {
        setCapturingKey(false);
        return;
      }
      // The desktop app keeps the modifiers too, for a global shortcut such
      // as Ctrl + Shift + T. It waits while only a modifier key is down.
      const pttKeyCode = desktopFeatures() ? shortcutFromEvent(event) : event.code;
      if (!pttKeyCode) {
        return;
      }
      updateVoiceDeviceSettings({ pttKeyCode });
      applyVoiceInputMode();
      setCapturingKey(false);
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [capturingKey]);

  function handleClose(): void {
    setMicTestOn(false);
    setCapturingKey(false);
    onClose();
  }

  function setInputMode(mode: VoiceInputMode): void {
    updateVoiceDeviceSettings({ inputMode: mode });
    applyVoiceInputMode();
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={handleClose}
      className="w-full max-w-md p-6"
      aria-label="Voice and video settings"
    >
      <h2 className="mb-4 text-lg font-semibold">Voice and video</h2>

      {!devices.labelsKnown && (
        <div className="mb-4">
          <button
            type="button"
            onClick={() => void requestMicPermission()}
            className="btn btn-primary"
          >
            Allow microphone access
          </button>
        </div>
      )}
      {permissionError && (
        <p role="alert" className="mb-4 text-sm text-danger-text">
          {permissionError}
        </p>
      )}

      <div className="mb-4">
        <label htmlFor="voice-input-device" className="mb-1 block text-sm font-medium">
          Microphone
        </label>
        <select
          id="voice-input-device"
          className="field w-full px-2 py-1.5 text-sm"
          value={settings.inputDeviceId ?? ""}
          onChange={(event) => {
            const deviceId = event.target.value || null;
            updateVoiceDeviceSettings({ inputDeviceId: deviceId });
            if (deviceId) applyInputDeviceLive(deviceId);
          }}
        >
          <option value="">Default microphone</option>
          {devices.inputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || "Microphone"}
            </option>
          ))}
        </select>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setMicTestOn((v) => !v)}
            className="rounded px-2 py-1 text-xs"
            style={{ backgroundColor: "var(--color-bg-main)" }}
          >
            {micTestOn ? "Stop mic test" : "Test microphone"}
          </button>
          {micTestOn && (
            <div
              className="h-2 flex-1 overflow-hidden rounded"
              style={{ backgroundColor: "var(--color-bg-main)" }}
              role="meter"
              aria-label="Microphone level"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(micLevel * 100)}
            >
              <div
                className="h-full rounded"
                style={{ width: `${Math.round(micLevel * 100)}%`, backgroundColor: "#3ba55d" }}
              />
            </div>
          )}
        </div>
      </div>

      {outputDeviceSelectSupported ? (
        <div className="mb-4">
          <label htmlFor="voice-output-device" className="mb-1 block text-sm font-medium">
            Speaker
          </label>
          <select
            id="voice-output-device"
            className="field w-full px-2 py-1.5 text-sm"
            value={settings.outputDeviceId ?? ""}
            onChange={(event) => {
              const deviceId = event.target.value || null;
              updateVoiceDeviceSettings({ outputDeviceId: deviceId });
              if (deviceId) applyOutputDeviceLive(deviceId);
            }}
          >
            <option value="">Default speaker</option>
            {devices.outputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || "Speaker"}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="mb-4 text-sm text-muted">
          Your browser cannot change the output device.
        </p>
      )}

      <div className="mb-4">
        <label htmlFor="voice-camera-device" className="mb-1 block text-sm font-medium">
          Camera
        </label>
        <select
          id="voice-camera-device"
          className="field mb-2 w-full px-2 py-1.5 text-sm"
          value={settings.cameraDeviceId ?? ""}
          onChange={(event) => {
            const deviceId = event.target.value || null;
            updateVoiceDeviceSettings({ cameraDeviceId: deviceId });
            if (deviceId) applyCameraDeviceLive(deviceId);
          }}
        >
          <option value="">Default camera</option>
          {devices.cameras.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || "Camera"}
            </option>
          ))}
        </select>
        <div
          className="flex aspect-video items-center justify-center overflow-hidden rounded"
          style={{ backgroundColor: "var(--color-bg-main)" }}
        >
          {cameraStream ? (
            <video
              ref={cameraVideoRef}
              muted
              playsInline
              autoPlay
              className="h-full w-full object-cover"
              style={{ transform: "scaleX(-1)" }}
            />
          ) : (
            <span className="text-xs text-muted">
              No camera preview
            </span>
          )}
        </div>
      </div>

      <fieldset className="mb-4">
        <legend className="mb-1 text-sm font-medium">Input mode</legend>
        <label className="mb-1 flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="voice-input-mode"
            checked={settings.inputMode === "voice-activity"}
            onChange={() => setInputMode("voice-activity")}
          />
          Voice activity
        </label>
        <label className="mb-1 flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="voice-input-mode"
            checked={settings.inputMode === "push-to-talk"}
            onChange={() => setInputMode("push-to-talk")}
          />
          Push to talk
        </label>
        {settings.inputMode === "push-to-talk" && (
          <div className="ml-6 mt-1 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCapturingKey(true)}
              className="rounded px-2 py-1 text-xs"
              style={{ backgroundColor: "var(--color-bg-main)" }}
            >
              {capturingKey ? "Press a key…" : settings.pttKeyCode ? `Key: ${describeKeyCode(settings.pttKeyCode)}` : "Set key"}
            </button>
            <span className="text-xs text-muted">
              {desktopFeatures()?.pushToTalkHint ?? "Push to talk works only while this window has focus."}
            </span>
          </div>
        )}
      </fieldset>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={handleClose}
          className="btn btn-primary"
        >
          Done
        </button>
      </div>
    </dialog>
  );
}
