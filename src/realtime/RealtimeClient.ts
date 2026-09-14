import {
  SERVER,
  describeClose,
  responseCreate,
  userTextItem,
  type ClientEvent,
  type CloseInfo,
  type ServerEvent,
} from "./events";
import { buildSessionConfig } from "./sessionConfig";
import { RingPlayer } from "../audio/playback";

// The model can also be set in session.update; passing it in the URL means the
// server knows which model you want before the first byte of config arrives.
const WS_URL = "wss://api.boson.ai/v1/realtime?model=higgs-realtime";

export type ConnectionState = "idle" | "connecting" | "open" | "closing" | "closed";

/** Coarse state for the status bar. */
export type Activity = "idle" | "thinking" | "speaking";

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
  private cb: RealtimeCallbacks;

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
      if (!speaking) this.setActivity("idle");
    });
  }

  get connectionState(): ConnectionState {
    return this.state;
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
        this.setActivity("thinking");
        break;

      case SERVER.outputAudioDelta: {
        // The audio itself: base64 PCM16 in `delta`.
        const b64 = evt.delta;
        if (typeof b64 === "string" && b64.length > 0) {
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
