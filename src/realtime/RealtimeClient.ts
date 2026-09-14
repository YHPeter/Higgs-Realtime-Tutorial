import {
  SERVER,
  describeClose,
  inputAudioAppend,
  responseCreate,
  truncateItem,
  userTextItem,
  type ClientEvent,
  type CloseInfo,
  type ServerEvent,
} from "./events";
import { buildSessionConfig } from "./sessionConfig";
import { RingPlayer } from "../audio/playback";
import { MicCapture } from "../audio/capture";

// The model can also be set in session.update; passing it in the URL means the
// server knows which model you want before the first byte of config arrives.
const WS_URL = "wss://api.boson.ai/v1/realtime?model=higgs-realtime";

export type ConnectionState = "idle" | "connecting" | "open" | "closing" | "closed";

/** Coarse state for the status bar. */
export type Activity = "idle" | "listening" | "thinking" | "speaking";

export interface LogEntry {
  id: number;
  dir: "recv" | "send" | "info";
  type: string;
  at: number;
  raw: unknown;
}

export interface RealtimeCallbacks {
  onConnectionState?: (s: ConnectionState) => void;
  onActivity?: (a: Activity) => void;
  onLog?: (entry: LogEntry) => void;
  onServerEvent?: (evt: ServerEvent) => void;
  onClose?: (info: CloseInfo) => void;
  /** Fired when the microphone starts or stops. */
  onMicChange?: (active: boolean) => void;
  /** Live microphone level (RMS, ~10 per second) for the meter. */
  onMicLevel?: (rms: number) => void;
  /** Mints a fresh ephemeral key for each connection. Required. */
  tokenProvider: () => Promise<string>;
}

let logSeq = 0;

/**
 * Everything to do with the WebSocket lives here, behind a callback interface.
 * React components never touch the socket — they render what this reports.
 */
export class RealtimeClient {
  private ws: WebSocket | null = null;
  private state: ConnectionState = "idle";
  private player: RingPlayer;
  private capture: MicCapture;
  private cb: RealtimeCallbacks;

  /**
   * The assistant item currently producing audio. This is what we truncate on
   * barge-in, so we track it from whichever event mentions it first.
   */
  private currentAssistantItemId: string | null = null;

  /**
   * ⚠ The single most important line in this file.
   *
   * React StrictMode mounts every component twice in development, so an effect
   * that calls connect() opens two sockets.
   *
   * The API does not stop you: verified 2026-08-07, two sockets sharing one
   * ephemeral key both get their own session.created with different session
   * ids, and both keep working. So there is no error to notice — just two live
   * conversations, two audio streams playing over each other, and two sessions
   * on the bill. It sounds like the model is echoing itself.
   *
   * Guarding here rather than in the component means it holds for every caller,
   * including a user double-clicking the button.
   */
  private connecting = false;

  constructor(callbacks: RealtimeCallbacks) {
    this.cb = callbacks;
    this.player = new RingPlayer((speaking) => {
      if (!speaking) this.setActivity(this.capture?.active ? "listening" : "idle");
    });
    this.capture = new MicCapture(
      (base64) => this.send(inputAudioAppend(base64)),
      (rms) => this.cb.onMicLevel?.(rms),
    );
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get micActive(): boolean {
    return this.capture.active;
  }

  /** Start streaming microphone audio. Throws if permission is denied. */
  async startMic(): Promise<void> {
    await this.capture.start();
    this.cb.onMicChange?.(true);
    this.setActivity("listening");
    this.info("Microphone started.");
  }

  async stopMic(): Promise<void> {
    await this.capture.stop();
    this.cb.onMicChange?.(false);
    this.cb.onMicLevel?.(0);
    this.setActivity("idle");
    this.info("Microphone stopped.");
  }

  /** Mint a key and open the socket. Safe to call twice; the second is ignored. */
  async connect(): Promise<void> {
    if (this.connecting || this.state === "open" || this.state === "connecting") {
      this.info("connect() ignored — a connection is already active.");
      return;
    }
    this.connecting = true;
    this.setState("connecting");

    // Must happen inside the user gesture that triggered this call, or the
    // browser leaves the AudioContext suspended and playback is silent.
    await this.player.resume();

    let key: string;
    try {
      key = await this.cb.tokenProvider();
    } catch (e) {
      this.connecting = false;
      this.setState("closed");
      const message = e instanceof Error ? e.message : String(e);
      this.cb.onClose?.({ code: 0, reason: "", message: `Token error: ${message}`, retryable: false });
      return;
    }

    // A browser cannot set headers on a WebSocket handshake, so there is no
    // `Authorization` header to use. The API takes the credential as a
    // subprotocol instead: "realtime" names the protocol, and the second entry
    // carries the ephemeral key.
    const ws = new WebSocket(WS_URL, ["realtime", `bai-client-secret.${key}`]);
    this.ws = ws;

    ws.onopen = () => {
      this.connecting = false;
      this.setState("open");
      this.info("Socket open — sending session.update.");
      this.send(buildSessionConfig());
    };
    ws.onmessage = (ev) => this.onMessage(ev);
    ws.onerror = () => this.info("WebSocket error — the close code below has the detail.");
    ws.onclose = (ev) => {
      this.connecting = false;
      this.ws = null;
      const info = describeClose(ev.code, ev.reason);
      this.log("info", `close:${ev.code}`, info);
      this.setState("closed");
      this.setActivity("idle");
      this.cb.onClose?.(info);
    };
  }

  disconnect(): void {
    if (this.ws && (this.state === "open" || this.state === "connecting")) {
      this.setState("closing");
      this.ws.close(1000, "client disconnect");
    } else {
      this.setState("closed");
    }
    void this.capture.stop().then(() => this.cb.onMicChange?.(false));
  }

  /** Send a typed message and ask for a reply. */
  sendUserText(text: string): void {
    if (this.state !== "open") {
      this.info("sendUserText ignored — the socket is not open.");
      return;
    }
    this.send(userTextItem(text));
    // Adding the message does not start a turn. This does.
    this.send(responseCreate());
    this.setActivity("thinking");
  }

  send(evt: ClientEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(evt));
    this.log("send", evt.type, evt);
  }

  async close(): Promise<void> {
    this.disconnect();
    await this.capture.stop();
    await this.player.close();
  }

  // --- internals -------------------------------------------------------------

  private onMessage(ev: MessageEvent): void {
    let evt: ServerEvent;
    try {
      evt = JSON.parse(ev.data as string);
    } catch {
      this.info(`Ignoring non-JSON message: ${String(ev.data).slice(0, 80)}`);
      return;
    }

    // Log first, act second. Everything the server says shows up in the drawer,
    // including the events no branch below handles.
    this.log("recv", evt.type, evt);
    this.cb.onServerEvent?.(evt);

    switch (evt.type) {
      case SERVER.responseCreated:
        // A new assistant turn. Zero the played-sample counter so the truncate
        // maths below measures into *this* reply, not the whole session.
        this.player.reset();
        this.setActivity("thinking");
        break;

      case SERVER.speechStarted:
        // The user started talking over the model. This is the barge-in path.
        void this.handleBargeIn();
        break;

      case SERVER.speechStopped:
        this.setActivity("thinking");
        break;

      case SERVER.outputItemAdded: {
        const item = evt.item as { id?: string; type?: string } | undefined;
        if (item?.type === "message" && typeof item.id === "string") {
          this.currentAssistantItemId = item.id;
        }
        break;
      }

      case SERVER.outputAudioDelta: {
        // The audio itself: base64 PCM16 in `delta`.
        const b64 = evt.delta;
        if (typeof b64 === "string" && b64.length > 0) {
          if (typeof evt.item_id === "string") this.currentAssistantItemId = evt.item_id;
          this.player.enqueueBase64(b64);
          this.setActivity("speaking");
        }
        break;
      }

      case SERVER.error:
        // Never let these pass silently. A session field the server rejected is
        // reported here and nowhere else — if you are not watching, your config
        // is quietly not doing what you think it is.
        this.info(`server error: ${JSON.stringify(evt.error ?? evt)}`);
        break;

      default:
        // Unrecognised event types are normal — the server sends more than we
        // handle. They are already logged. Never throw here.
        break;
    }
  }

  /**
   * Barge-in. Two things have to happen, and the second is the one everybody
   * forgets.
   *
   * 1. Stop playing at once. We may be holding several seconds of audio the
   *    user has not heard yet; without this, the model keeps talking over them.
   *
   * 2. Tell the server how much was actually heard. The server has already
   *    stored the whole reply as a conversation item, so its memory now
   *    contains words that never reached anyone's ears. Left alone, the model
   *    will refer back to things it "said" that the user never heard — and
   *    "sorry, what was that last bit?" gets answered from the wrong text.
   *
   * `flush()` resolves with the played-sample count converted to milliseconds,
   * which is exactly `audio_end_ms`. Note we do NOT send response.create here:
   * the server's own VAD starts the new user turn.
   */
  private async handleBargeIn(): Promise<void> {
    this.setActivity("listening");
    const playedMs = await this.player.flush();
    if (this.currentAssistantItemId && playedMs > 0) {
      this.send(truncateItem(this.currentAssistantItemId, playedMs));
    }
    this.currentAssistantItemId = null;
  }

  private setState(s: ConnectionState): void {
    this.state = s;
    this.cb.onConnectionState?.(s);
  }

  private setActivity(a: Activity): void {
    this.cb.onActivity?.(a);
  }

  private info(message: string): void {
    this.log("info", "info", message);
  }

  private log(dir: LogEntry["dir"], type: string, raw: unknown): void {
    this.cb.onLog?.({ id: ++logSeq, dir, type, at: Date.now(), raw });
  }
}
