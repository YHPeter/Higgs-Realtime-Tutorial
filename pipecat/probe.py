"""Call a running bot.py the way the playground does, with no browser or microphone.

    uv run probe.py

It starts a call through the same endpoint the playground uses (POST /start),
connects over WebRTC, sends the RTVI client-ready message and waits for the
bot's greeting. Everything the bot sends back over RTVI is printed with a
timestamp. If this passes, the key, the model and the WebRTC path all work.
"""

import argparse
import asyncio
import json
import time

import aiohttp
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import AudioStreamTrack

SHOWN = {"bot-ready", "bot-started-speaking"}


class Call:
    """The RTVI messages the bot sends, and the turn count."""

    def __init__(self):
        self.t0 = time.monotonic()
        self.turns = asyncio.Queue()
        self.bot_text: list[str] = []
        self.failure: str | None = None

    def log(self, *args):
        print(f"{time.monotonic() - self.t0:6.2f}s", *args, flush=True)

    def on_rtvi(self, raw: str):
        message = json.loads(raw)
        kind, data = message.get("type"), message.get("data") or {}
        if kind == "bot-llm-text":
            self.bot_text.append(data.get("text", ""))
        elif kind == "bot-stopped-speaking":
            reply = "".join(self.bot_text).strip()
            self.bot_text.clear()
            self.log("bot said:", reply)
            self.turns.put_nowait(reply)
        elif kind == "error":
            self.log("error:", data.get("error"))
            if data.get("fatal"):
                self.failure = data.get("error") or "fatal error"
                self.turns.put_nowait(None)
        elif kind in SHOWN:
            self.log(kind)


def rtvi(kind: str, data: dict) -> str:
    return json.dumps({"id": f"probe-{kind}", "label": "rtvi-ai", "type": kind, "data": data})


async def main(url: str, timeout: float):
    call = Call()
    pc = RTCPeerConnection()
    pc.addTrack(AudioStreamTrack())  # a silent microphone: WebRTC needs a track to send
    channel = pc.createDataChannel("rtvi")
    # RTVI handshake: the bot greets once the client says it is ready.
    channel.on("open", lambda: channel.send(rtvi("client-ready", {"version": "1.0.0"})))
    channel.on("message", call.on_rtvi)

    async with aiohttp.ClientSession() as http:
        # POST /start: what the playground's Connect button does.
        async with http.post(f"{url}/start", json={"transport": "webrtc"}) as response:
            response.raise_for_status()
            session_id = (await response.json())["sessionId"]
        await pc.setLocalDescription(await pc.createOffer())
        offer = {"sdp": pc.localDescription.sdp, "type": "offer"}
        async with http.post(f"{url}/sessions/{session_id}/api/offer", json=offer) as response:
            response.raise_for_status()
            answer = await response.json()
    await pc.setRemoteDescription(RTCSessionDescription(answer["sdp"], answer["type"]))
    call.log("WebRTC connected; waiting for the greeting")

    try:
        await asyncio.wait_for(call.turns.get(), timeout)  # the greeting
    finally:
        await pc.close()
    if call.failure:
        raise SystemExit(f"FAIL: {call.failure}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", default="http://localhost:7860", help="where bot.py is running")
    parser.add_argument("--timeout", type=float, default=60)
    args = parser.parse_args()
    asyncio.run(main(args.url.rstrip("/"), args.timeout))
