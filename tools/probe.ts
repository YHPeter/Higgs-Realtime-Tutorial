/**
 * A headless Realtime session, in one file.
 *
 * Run it with `npm run probe`. It mints an ephemeral key, opens the socket,
 * sends the same session config the browser app sends, asks one question as
 * text, prints every server event as it arrives, and writes the whole stream to
 * `captures/`.
 *
 * This is not part of the app — it is a debugging instrument, and it is worth
 * having for three reasons:
 *
 *  1. When something breaks, it tells you whether the problem is your audio
 *     code or your protocol code. The probe has no audio code at all.
 *  2. `session.created` echoes back the *resolved* session — every default the
 *     server filled in for you. That is the only way to see what you actually
 *     got, as opposed to what you asked for.
 *  3. The captured event stream is a fixture. Real recorded events, replayable
 *     in a unit test, beat hand-written ones every time.
 *
 * Usage:
 *   npm run probe
 *   npm run probe -- "what is the capital of France?"
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import dotenv from "dotenv";
import { buildSessionConfig } from "../src/realtime/sessionConfig";
import { responseCreate, userTextItem, describeClose } from "../src/realtime/events";

dotenv.config();

const BOSON_BASE_URL = process.env.BOSON_BASE_URL ?? "https://api.boson.ai";
const WS_URL = "wss://api.boson.ai/v1/realtime?model=higgs-realtime";
const PROMPT = process.argv[2] ?? "In one short sentence, what is a sample rate?";

function loadApiKey(): string {
  const inline = process.env.BOSON_API_KEY?.trim();
  if (inline) return inline;
  const keyFile = process.env.BOSON_API_KEY_FILE;
  if (keyFile) {
    const fromFile = readFileSync(keyFile, "utf8").trim();
    if (fromFile) return fromFile;
  }
  throw new Error("No API key. Set BOSON_API_KEY or BOSON_API_KEY_FILE in .env.");
}

async function mintEphemeralKey(apiKey: string): Promise<string> {
  const res = await fetch(`${BOSON_BASE_URL}/v1/realtime/client_secrets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expires_after: { seconds: 600 } }),
  });
  if (!res.ok) throw new Error(`client_secrets ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { value: string };
  return data.value;
}

/** One line per event: type, plus whichever field carries the payload. */
function summarize(evt: Record<string, unknown>): string {
  const type = String(evt.type);
  if (type === "response.output_audio.delta") {
    const b64 = typeof evt.delta === "string" ? evt.delta : "";
    // 4 base64 chars -> 3 bytes -> 1.5 PCM16 samples.
    const samples = Math.round((b64.length * 0.75) / 2);
    return `${type}  ${b64.length} b64 chars ≈ ${samples} samples ≈ ${((samples / 24000) * 1000).toFixed(0)}ms`;
  }
  if (typeof evt.delta === "string") return `${type}  ${JSON.stringify(evt.delta)}`;
  if (typeof evt.transcript === "string") return `${type}  ${JSON.stringify(evt.transcript)}`;
  if (type === "error") return `${type}  ${JSON.stringify(evt.error ?? evt)}`;
  return type;
}

async function main() {
  const key = await mintEphemeralKey(loadApiKey());
  console.log(`minted ${key.slice(0, 12)}…\nconnecting to ${WS_URL}\n`);

  const events: unknown[] = [];
  const startedAt = Date.now();
  let audioChunks = 0;
  let audioSamples = 0;

  // The ephemeral key travels in the WebSocket subprotocol list, not in a
  // header — browsers cannot set headers on a WebSocket handshake, so the API
  // uses this instead. "realtime" identifies the protocol; the second entry
  // carries the credential.
  const ws = new WebSocket(WS_URL, ["realtime", `bai-client-secret.${key}`]);

  ws.addEventListener("open", () => {
    console.log("open — sending session.update\n");
    ws.send(JSON.stringify(buildSessionConfig()));
    ws.send(JSON.stringify(userTextItem(PROMPT)));
    ws.send(JSON.stringify(responseCreate()));
  });

  ws.addEventListener("message", (ev) => {
    const evt = JSON.parse(String(ev.data)) as Record<string, unknown>;
    events.push(evt);

    if (evt.type === "response.output_audio.delta") {
      const b64 = typeof evt.delta === "string" ? evt.delta : "";
      audioChunks++;
      audioSamples += Math.round((b64.length * 0.75) / 2);
      if (audioChunks > 1) return; // print only the first, then count silently
    }

    console.log(`[${String(Date.now() - startedAt).padStart(5)}ms] ${summarize(evt)}`);

    // session.created carries the RESOLVED session: our fields plus every
    // default the server filled in. Print it in full — this is the single most
    // useful thing in the whole probe.
    if (evt.type === "session.created") {
      console.log("\n--- resolved session (server defaults included) ---");
      console.log(JSON.stringify(evt.session, null, 2));
      console.log("---\n");
    }

    if (evt.type === "response.done") {
      console.log(
        `\naudio: ${audioChunks} chunks, ${audioSamples} samples ≈ ${(audioSamples / 24000).toFixed(2)}s`,
      );
      ws.close(1000, "probe complete");
    }
  });

  ws.addEventListener("close", (ev) => {
    const info = describeClose(ev.code, ev.reason);
    console.log(`\nclosed: ${info.message}`);

    mkdirSync("captures", { recursive: true });
    const path = `captures/probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(path, JSON.stringify(events, null, 2));
    console.log(`${events.length} events written to ${path}`);
    process.exit(info.code === 1000 ? 0 : 1);
  });

  ws.addEventListener("error", () => {
    // The close event that follows carries the useful information; a WebSocket
    // "error" on its own tells you nothing.
    console.error("socket error — see the close code below");
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
