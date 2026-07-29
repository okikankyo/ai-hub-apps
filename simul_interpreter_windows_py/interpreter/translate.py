# ---------------------------------------------------------------------
# Copyright (c) 2025 Qualcomm Technologies, Inc. and/or its subsidiaries.
# SPDX-License-Identifier: BSD-3-Clause
# ---------------------------------------------------------------------
"""Text-to-text translation for the simultaneous interpreter.

There is no ready-made machine-translation model in Qualcomm AI Hub Models, so
translation is done with an on-device LLM through the Genie SDK -- the same
NPU-accelerated generative-AI path used by ../chatapp_android. On Windows, the
QAIRT SDK ships a `genie-t2t-run` CLI that runs a Genie config (model context
binaries + tokenizer) and returns a completion for a prompt; we build the
prompt with the model's own chat template, exactly like
chatapp_android/src/main/cpp/PromptHandler.cpp does for the JNI API.
"""

from __future__ import annotations

import json
import logging
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol

logger = logging.getLogger(__name__)

# Kept deliberately terse and single-purpose: these are sent verbatim as the
# "system" turn, and the model is a general-purpose instruct LLM, not a
# translation-specialized one, so it needs to be told not to add commentary.
TRANSLATION_SYSTEM_PROMPTS: dict[tuple[str, str], str] = {
    ("ja", "en"): (
        "You are a professional simultaneous interpreter for tourism. "
        "Translate the Japanese text the user sends into natural, concise English. "
        "Output only the translation. No explanations, no quotes, no notes."
    ),
    ("en", "ja"): (
        "You are a professional simultaneous interpreter for tourism. "
        "Translate the English text the user sends into natural, concise Japanese. "
        "Output only the translation. No explanations, no quotes, no notes."
    ),
}


class Translator(Protocol):
    def translate(self, text: str, source_lang: str, target_lang: str) -> str: ...


@dataclass
class ChatTemplate:
    """Mirrors the `genie.chat_template` block in an AI Hub Models LLM export's
    metadata.json (see chatapp_android's PromptHandler for the C++ equivalent)."""

    system_prefix: str
    system_suffix: str
    user_prefix: str
    user_suffix: str
    assistant_prefix: str

    @classmethod
    def from_metadata_json(cls, path: str | Path) -> ChatTemplate:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        tmpl = data["genie"]["chat_template"]
        return cls(
            system_prefix=tmpl["system_prefix"],
            system_suffix=tmpl["system_suffix"],
            user_prefix=tmpl["user_prefix"],
            user_suffix=tmpl["user_suffix"],
            assistant_prefix=tmpl["assistant_prefix"],
        )

    def build_prompt(self, system_prompt: str, user_prompt: str) -> str:
        return (
            f"{self.system_prefix}{system_prompt}{self.system_suffix}"
            f"{self.user_prefix}{user_prompt}{self.user_suffix}"
            f"{self.assistant_prefix}"
        )


class GenieTranslator:
    """Runs translation prompts through the QAIRT SDK's `genie-t2t-run` CLI against
    an NPU-accelerated LLM (e.g. Llama 3.2 3B Instruct), configured the same way as
    chatapp_android's genie_config.json.

    The exact CLI flags and stdout format of `genie-t2t-run` can vary by QAIRT SDK
    version -- check `genie-t2t-run --help` on your machine and adjust
    `config_flag`/`prompt_flag`/`response_parser` if needed.
    """

    def __init__(
        self,
        genie_config_path: str | Path,
        chat_template_path: str | Path,
        executable: str = "genie-t2t-run.exe",
        config_flag: str = "--config",
        prompt_flag: str = "--prompt",
        timeout_seconds: float = 30.0,
        response_parser: Callable[[str], str] | None = None,
    ) -> None:
        self._genie_config_path = str(genie_config_path)
        self._template = ChatTemplate.from_metadata_json(chat_template_path)
        self._executable = executable
        self._config_flag = config_flag
        self._prompt_flag = prompt_flag
        self._timeout_seconds = timeout_seconds
        self._response_parser = response_parser or self._default_response_parser

    def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        system_prompt = TRANSLATION_SYSTEM_PROMPTS.get((source_lang, target_lang))
        if system_prompt is None:
            raise ValueError(
                f"No translation prompt configured for {source_lang!r} -> {target_lang!r}"
            )
        if not text.strip():
            return ""

        prompt = self._template.build_prompt(system_prompt, text)
        completed = subprocess.run(
            [
                self._executable,
                self._config_flag,
                self._genie_config_path,
                self._prompt_flag,
                prompt,
            ],
            capture_output=True,
            text=True,
            timeout=self._timeout_seconds,
            check=True,
        )
        return self._response_parser(completed.stdout)

    @staticmethod
    def _default_response_parser(stdout: str) -> str:
        return stdout.strip()


class EchoTranslator:
    """Dev/test stand-in for `GenieTranslator` that requires no model, NPU, or
    Windows-only executable. Not a real translator -- only used to exercise the
    rest of the pipeline (ASR wiring, GUI, conversation/back-translation logic)
    on machines without Genie set up."""

    _TAG = {"ja": "EN", "en": "JA"}

    def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        if not text.strip():
            return ""
        return f"[{self._TAG.get(source_lang, target_lang.upper())}] {text}"


class ClaudeTranslator:
    """Translates over the network via the Claude API. Higher translation
    quality than a small on-device LLM, at the cost of needing connectivity --
    not a substitute for `GenieTranslator`, but a good primary for
    `FallbackTranslator` below when the guest device has signal.

    Defaults to a fast/cheap model since this sits on the latency-critical
    path of a real-time interpreter; pass a different `model` for higher
    quality if latency allows.
    """

    def __init__(
        self,
        api_key: str | None = None,
        model: str = "claude-haiku-4-5-20251001",
        max_tokens: int = 1024,
        timeout_seconds: float = 15.0,
    ) -> None:
        from anthropic import Anthropic

        # api_key=None falls back to the ANTHROPIC_API_KEY environment variable.
        self._client = Anthropic(api_key=api_key, timeout=timeout_seconds)
        self._model = model
        self._max_tokens = max_tokens

    def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        system_prompt = TRANSLATION_SYSTEM_PROMPTS.get((source_lang, target_lang))
        if system_prompt is None:
            raise ValueError(
                f"No translation prompt configured for {source_lang!r} -> {target_lang!r}"
            )
        if not text.strip():
            return ""

        response = self._client.messages.create(
            model=self._model,
            max_tokens=self._max_tokens,
            system=system_prompt,
            messages=[{"role": "user", "content": text}],
        )
        return "".join(
            block.text for block in response.content if block.type == "text"
        ).strip()


class FallbackTranslator:
    """Tries `primary` first; if it raises (e.g. `ClaudeTranslator` with no
    network), falls back to `secondary` (e.g. `GenieTranslator`, fully
    on-device) so the interpreter keeps working when the guest device has no
    connectivity -- common at tourist sites."""

    def __init__(self, primary: Translator, secondary: Translator) -> None:
        self._primary = primary
        self._secondary = secondary

    def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        try:
            return self._primary.translate(text, source_lang, target_lang)
        except Exception:
            logger.warning(
                "Primary translator failed for %r -> %r, falling back",
                source_lang,
                target_lang,
                exc_info=True,
            )
            return self._secondary.translate(text, source_lang, target_lang)
