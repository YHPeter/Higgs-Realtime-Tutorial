import type { ClientEvent } from "./events";

/**
 * The first thing we send after the socket opens.
 *
 * `session.update` configures the whole session: who the model is, what it
 * sounds like, and what audio format both directions use. The first one you
 * send starts the session and is acknowledged with `session.created`; later
 * ones are acknowledged with `session.updated`.
 *
 * Every field here is set deliberately. Fields this part does not need —
 * turn detection (Part 2), tools (Part 4) — are simply absent, and take the
 * server's documented defaults.
 */

// The prompt follows the structure in docs/part-5.md — role and capabilities,
// speaking style, turn-taking, tool-use policy, spoken-output constraints —
// and it is deliberately SHORT. While building this tutorial, six extra
// sentences of behavioural rules appended here stopped the model calling
// tools at all. Guidance about a specific tool belongs in that tool's
// description, not here.
export const SYSTEM_PROMPT = [
  "You are a friendly voice assistant being used to test a browser audio pipeline.",
  "Keep every reply to one or two short sentences.",
  "You are speaking aloud, not writing — no lists, no markdown, no emoji.",
].join(" ");

/**
 * PCM16 at 24 kHz, both directions.
 *
 * `audio/pcm` means raw 16-bit signed samples, little-endian, mono — no
 * container, no compression, just numbers. 24000 is the documented default rate
 * and it is what we pin here, for a reason that matters later: our playback
 * AudioContext also runs at 24000, so one sample out of the API is exactly one
 * sample into the speakers. In Part 2 that one-to-one mapping is what lets us
 * tell the server precisely how much audio the user actually heard.
 *
 * The API also accepts 8000, 16000 and 48000 for PCM, plus `audio/pcmu`
 * (G.711 µ-law, telephony) and `audio/opus` (compressed). PCM is the right
 * choice while learning: no decoder, nothing to go wrong.
 */
export const AUDIO_RATE = 24000;

export function buildSessionConfig(): ClientEvent {
  return {
    type: "session.update",
    session: {
      model: "higgs-realtime",
      instructions: SYSTEM_PROMPT,
      // Exactly ["audio"] or exactly ["text"] — this is not a list you can mix.
      // Asking for audio still gives you a text transcript of what was spoken,
      // via the response.output_audio_transcript.* events.
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcm", rate: AUDIO_RATE },
          // PART 2: switch on turn detection.
          //
          // This is not optional-but-nice. The server's default is `null`,
          // meaning no turn detection at all — you would stream audio forever
          // and the model would never decide you had finished speaking.
          //
          // We send the bare type and take the documented defaults: threshold
          // 0.55, prefix_padding_ms 300, silence_duration_ms 500,
          // min_speech_duration 0.125. All four are honoured if you do set
          // them; see the ack discussion in docs/part-2.md before you tune
          // anything.
          turn_detection: { type: "server_vad" },
          // PART 3: transcribe the user's speech.
          //
          // Off by default — the ack shows `model: ""` if you omit this — and
          // it is what lets you show the user's own words on screen. The model
          // understands your speech either way; this is purely so *you* can
          // read it.
          //
          // The model name is validated at session.update time: a name the
          // endpoint does not serve fails the update with an error naming it.
          // As of this writing, "higgs-stt-3.1" is the one to use.
          transcription: { model: "higgs-stt-3.1", language: "en" },
        },
        output: {
          format: { type: "audio/pcm", rate: AUDIO_RATE },
          voice: "default",
        },
      },
    },
  };
}
