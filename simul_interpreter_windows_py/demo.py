# ---------------------------------------------------------------------
# Copyright (c) 2025 Qualcomm Technologies, Inc. and/or its subsidiaries.
# SPDX-License-Identifier: BSD-3-Clause
# ---------------------------------------------------------------------
"""Dual-display, real-time Japanese <-> English simultaneous interpreter for
face-to-face use (e.g. tourism), running speech recognition on the Snapdragon
NPU via Whisper/QNN and translation via a Genie SDK LLM."""

from __future__ import annotations

import argparse
import logging

from interpreter.asr import WhisperTranscriber
from interpreter.conversation import ConversationSession
from interpreter.display_layout import detect_dual_monitor_layout
from interpreter.translate import EchoTranslator, GenieTranslator, Translator
from interpreter.tts import Speaker, list_installed_voices


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

    session = ConversationSession(transcriber, translator)

    voice_by_lang = {}
    if args.ja_voice_id:
        voice_by_lang["ja"] = args.ja_voice_id
    if args.en_voice_id:
        voice_by_lang["en"] = args.en_voice_id
    speaker = Speaker(voice_by_lang=voice_by_lang, rate=args.tts_rate)

    layout = detect_dual_monitor_layout(guest_monitor_index=args.guest_monitor_index)

    # Imported here: Tk requires a display, which isn't available (or needed)
    # for --list-audio-devices/--list-voices above.
    from gui.app_window import InterpreterApp

    app = InterpreterApp(session=session, speaker=speaker, layout=layout)
    app.run()


if __name__ == "__main__":
    main()
