# ---------------------------------------------------------------------
# Copyright (c) 2025 Qualcomm Technologies, Inc. and/or its subsidiaries.
# SPDX-License-Identifier: BSD-3-Clause
# ---------------------------------------------------------------------
"""Live English -> Japanese subtitles for this PC's own audio output (e.g. a
YouTube video, or the other party's voice in an online call), for when you
can't get the other party to run any translation themselves. Runs as a small
always-on-top overlay alongside whatever app is actually playing the audio.

This is one-directional (English audio in, Japanese subtitles out) and
separate from demo.py's face-to-face dual-display conversation mode.
"""

from __future__ import annotations

import argparse
import logging
import queue
import threading
from typing import Callable, Optional

from interpreter.asr import WhisperTranscriber
from interpreter.audio_loopback import LoopbackChunk, LoopbackRecorder
from interpreter.summarize import EchoSummarizer, GenieSummarizer, Summarizer
from interpreter.transcript import TranscriptLog
from interpreter.translate import EchoTranslator, GenieTranslator, Translator

logger = logging.getLogger(__name__)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
        conflict_handler="error",
    )
    parser.add_argument(
        "--encoder-path", default="models\\whisper\\encoder.onnx", help="Whisper encoder path"
    )
    parser.add_argument(
        "--decoder-path", default="models\\whisper\\decoder.onnx", help="Whisper decoder path"
    )
    parser.add_argument(
        "--whisper-model-id",
        default="openai/whisper-base",
        help="Huggingface checkpoint id matching the exported encoder/decoder.",
    )

    parser.add_argument(
        "--translator",
        choices=["genie", "echo"],
        default="genie",
        help="'echo' does not actually translate -- it's a dev/test stand-in for "
        "exercising the overlay and pipeline without Genie/QAIRT installed.",
    )
    parser.add_argument(
        "--genie-config-path",
        default="models\\llm\\genie_config.json",
        help="Genie config (ctx-bins, tokenizer, sampler) -- same format as chatapp_android.",
    )
    parser.add_argument(
        "--genie-chat-template-path",
        default="models\\llm\\metadata.json",
        help="metadata.json shipped with the LLM export, containing genie.chat_template.",
    )
    parser.add_argument("--genie-executable", default="genie-t2t-run.exe")

    parser.add_argument(
        "--chunk-seconds",
        type=float,
        default=6.0,
        help="How many seconds of system audio to buffer before transcribing/"
        "translating. Lower is more responsive; higher is more accurate "
        "(Whisper has more context per call).",
    )
    parser.add_argument(
        "--loopback-device",
        type=int,
        default=None,
        help="Output device index to capture from (see --list-audio-devices). "
        "Defaults to the system's current default output device.",
    )
    parser.add_argument("--list-audio-devices", action="store_true")
    parser.add_argument("--log-level", default="INFO")
    return parser


def build_translator(args: argparse.Namespace) -> Translator:
    if args.translator == "echo":
        return EchoTranslator()
    return GenieTranslator(
        genie_config_path=args.genie_config_path,
        chat_template_path=args.genie_chat_template_path,
        executable=args.genie_executable,
    )


def build_summarizer(args: argparse.Namespace) -> Summarizer:
    """Reuses the same `--translator`/`--genie-*` flags as `build_translator`:
    the summarizer is the same on-device LLM, just with a different prompt,
    so there's no separate model to configure."""
    if args.translator == "echo":
        return EchoSummarizer()
    return GenieSummarizer(
        genie_config_path=args.genie_config_path,
        chat_template_path=args.genie_chat_template_path,
        executable=args.genie_executable,
    )


def run_pipeline(
    recorder: LoopbackRecorder,
    transcriber: WhisperTranscriber,
    translator: Translator,
    results: "queue.Queue[tuple[str, str] | None]",
    stop_event: threading.Event,
    on_entry: Optional[Callable[[str, str], None]] = None,
) -> None:
    """Pulls finished audio chunks off `recorder`, transcribes (English) and
    translates (-> Japanese) each one, and pushes (original, translated) text
    pairs onto `results`. Runs on a background thread; `stop_event` is how the
    caller asks it to exit. `on_entry`, if given, is called with
    (original_text, translated_text) for each entry -- e.g. to log it into a
    shared `interpreter.transcript.TranscriptLog`."""
    recorder.start()
    try:
        while not stop_event.is_set():
            try:
                chunk: LoopbackChunk = recorder.chunks.get(timeout=0.5)
            except queue.Empty:
                continue
            text = transcriber.transcribe(chunk.audio, chunk.sample_rate, "en").text
            if not text.strip():
                continue
            translated = translator.translate(text, "en", "ja")
            if on_entry is not None:
                on_entry(text, translated)
            results.put((text, translated))
    finally:
        recorder.stop()
        results.put(None)


def main() -> None:
    args = build_arg_parser().parse_args()
    logging.basicConfig(level=args.log_level)

    if args.list_audio_devices:
        import sounddevice as sd

        print(sd.query_devices())
        return

    translator = build_translator(args)

    print("Loading Whisper model...")
    transcriber = WhisperTranscriber(
        encoder_path=args.encoder_path,
        decoder_path=args.decoder_path,
        model_id=args.whisper_model_id,
    )

    summarizer = build_summarizer(args)
    transcript_log = TranscriptLog()

    recorder = LoopbackRecorder(
        chunk_seconds=args.chunk_seconds, device=args.loopback_device
    )
    results: "queue.Queue[tuple[str, str] | None]" = queue.Queue()
    stop_event = threading.Event()

    def on_entry(original: str, translated: str) -> None:
        transcript_log.append(
            source="pc_audio",
            original_lang="en",
            original_text=original,
            translated_lang="ja",
            translated_text=translated,
        )

    # Imported here: Tk requires a display, which isn't available (or needed)
    # for --list-audio-devices above.
    from gui.subtitle_overlay import SubtitleOverlay
    from gui.transcript_panel import TranscriptPanel

    overlay = SubtitleOverlay(on_close=stop_event.set)
    TranscriptPanel(transcript_log, summarizer, master=overlay.root)

    def poll() -> None:
        try:
            while True:
                item = results.get_nowait()
                if item is None:
                    return
                original, translated = item
                overlay.update_subtitle(original, translated)
        except queue.Empty:
            pass
        if not stop_event.is_set():
            overlay.root.after(200, poll)

    threading.Thread(
        target=run_pipeline,
        args=(recorder, transcriber, translator, results, stop_event, on_entry),
        daemon=True,
    ).start()
    poll()
    overlay.run()


if __name__ == "__main__":
    main()
