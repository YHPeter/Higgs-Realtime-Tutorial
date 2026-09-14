import { useCallback, useEffect, useRef, useState } from "react";
import {
  RealtimeClient,
  type Activity,
  type ConnectionState,
  type LogEntry,
} from "./realtime/RealtimeClient";
import { DebugDrawer } from "./ui/DebugDrawer";
import { StatusBar } from "./ui/StatusBar";

/** Ask our own server for a fresh ephemeral key. One per connection. */
async function fetchToken(): Promise<string> {
  const res = await fetch("/api/token");
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.value as string;
}

export default function App() {
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [activity, setActivity] = useState<Activity>("idle");
  const [log, setLog] = useState<LogEntry[]>([]);
  const [closeMessage, setCloseMessage] = useState<string | null>(null);
  const [text, setText] = useState("Hi! Say something short so I can check my speakers.");
  const [transcript, setTranscript] = useState("");

  // The client outlives re-renders, so it lives in a ref rather than state.
  const clientRef = useRef<RealtimeClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = new RealtimeClient({
      tokenProvider: fetchToken,
      onConnectionState: setConnection,
      onActivity: setActivity,
      onLog: (entry) => setLog((l) => [...l, entry]),
      onClose: (info) => setCloseMessage(info.message),
      onServerEvent: (evt) => {
        // A small preview of Part 3: the model's own words, streamed back as
        // text while it speaks. Part 3 turns this into a real transcript.
        if (evt.type === "response.output_audio_transcript.delta") {
          setTranscript((t) => t + (typeof evt.delta === "string" ? evt.delta : ""));
        }
      },
    });
  }

  useEffect(() => {
    const client = clientRef.current!;
    return () => void client.close();
  }, []);

  const connect = useCallback(async () => {
    setCloseMessage(null);
    await clientRef.current!.connect();
  }, []);

  const send = useCallback(() => {
    if (!text.trim()) return;
    setTranscript("");
    clientRef.current!.sendUserText(text);
  }, [text]);

  const isOpen = connection === "open";

  return (
    <main className="app">
      <h1>Higgs Realtime Tutorial</h1>
      <p className="lede">
        Part 1 — one WebSocket, one typed message, one spoken reply. Open the
        event log at the bottom to watch the protocol as it happens.
      </p>

      <StatusBar connection={connection} activity={activity} closeMessage={closeMessage} />

      <div className="row">
        <button onClick={connect} disabled={connection === "connecting" || isOpen}>
          {connection === "connecting" ? "Connecting…" : "Connect"}
        </button>
        <button onClick={() => clientRef.current!.disconnect()} disabled={!isOpen}>
          Disconnect
        </button>
      </div>

      <div className="row">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && isOpen && send()}
          placeholder="Type something for the model to say back…"
          disabled={!isOpen}
        />
        <button onClick={send} disabled={!isOpen}>
          Send
        </button>
      </div>

      {transcript && (
        <blockquote className="transcript">
          <span className="label">the model said</span>
          {transcript}
        </blockquote>
      )}

      <DebugDrawer entries={log} />
    </main>
  );
}
