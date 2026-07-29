# ---------------------------------------------------------------------
# Copyright (c) 2025 Qualcomm Technologies, Inc. and/or its subsidiaries.
# SPDX-License-Identifier: BSD-3-Clause
# ---------------------------------------------------------------------
"""One app, two interpreter modes, started from a single small launcher
window:

* Face-to-face conversation (dual-display) -- for in-person use (e.g. tourism).
* Live PC-audio subtitles -- English audio from this PC (a YouTube video, an
  online call) translated to Japanese in a small overlay, for when you can't
  get the other party to run any translation themselves.

Both modes share one loaded Whisper model (NPU/QNN) and one translator
(Genie SDK LLM, on-device/NPU) rather than loading either twice. Start
either mode, both, or switch between them without restarting the process.
"""

from __future__ import annotations

import argparse
import logging

from interpreter.asr import WhisperTranscriber
from interpreter.translate import EchoTranslator, GenieTranslator, Translator
from interpreter.tts import list_installed_voices


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
        "exercising the UI and pipeline without Genie/QAIRT installed.",
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

    # -- Face-to-face conversation mode options --
    parser.add_argument(
        "--ja-voice-id", default=None, help="SAPI5 voice id used to read Japanese aloud"
    )
    parser.add_argument(
        "--en-voice-id", default=None, help="SAPI5 voice id used to read English aloud"
    )
    parser.add_argument("--tts-rate", type=int, default=None)
    parser.add_argument(
        "--guest-monitor-index",
        type=int,
        default=1,
        help="Index (from screeninfo.get_monitors()) of the display facing the guest.",
    )

    # -- PC-audio live subtitles mode options --
    parser.add_argument(
        "--chunk-seconds",
        type=float,
        default=6.0,
        help="How many seconds of system audio to buffer before transcribing/"
        "translating in subtitles mode. Lower is more responsive; higher is "
        "more accurate (Whisper has more context per call).",
    )
    parser.add_argument(
        "--loopback-device",
        type=int,
        default=None,
        help="Output device index to capture from in subtitles mode (see "
        "--list-audio-devices). Defaults to the system's default output device.",
    )

    parser.add_argument("--list-audio-devices", action="store_true")
    parser.add_argument("--list-voices", action="store_true")
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


def main() -> None:
    args = build_arg_parser().parse_args()
    logging.basicConfig(level=args.log_level)

    if args.list_audio_devices:
        import sounddevice as sd

        print(sd.query_devices())
        return

    if args.list_voices:
        for voice_id, name in list_installed_voices():
            print(f"{voice_id}\t{name}")
        return

    translator = build_translator(args)

    print("Loading Whisper model...")
    transcriber = WhisperTranscriber(
        encoder_path=args.encoder_path,
        decoder_path=args.decoder_path,
        model_id=args.whisper_model_id,
    )

    # Imported here: Tk requires a display, which isn't available (or needed)
    # for --list-audio-devices/--list-voices above.
    from gui.launcher import LauncherApp

    app = LauncherApp(transcriber=transcriber, translator=translator, args=args)
    app.run()


if __name__ == "__main__":
    main()
