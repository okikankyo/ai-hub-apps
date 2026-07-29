import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from interpreter.translate import (
    TRANSLATION_SYSTEM_PROMPTS,
    ChatTemplate,
    ClaudeTranslator,
    EchoTranslator,
    FallbackTranslator,
    GenieTranslator,
)

METADATA = {
    "genie": {
        "chat_template": {
            "system_prefix": "<|system|>",
            "system_suffix": "<|end|>",
            "user_prefix": "<|user|>",
            "user_suffix": "<|end|>",
            "assistant_prefix": "<|assistant|>",
            "default_system_prompt": "You are a helpful assistant.",
        }
    }
}


@pytest.fixture
def metadata_path(tmp_path: Path) -> Path:
    path = tmp_path / "metadata.json"
    path.write_text(json.dumps(METADATA), encoding="utf-8")
    return path


def test_chat_template_from_metadata_json(metadata_path: Path):
    template = ChatTemplate.from_metadata_json(metadata_path)

    assert template.system_prefix == "<|system|>"
    assert template.assistant_prefix == "<|assistant|>"


def test_chat_template_build_prompt_order(metadata_path: Path):
    template = ChatTemplate.from_metadata_json(metadata_path)

    prompt = template.build_prompt("Translate to English.", "こんにちは")

    assert prompt == (
        "<|system|>Translate to English.<|end|>"
        "<|user|>こんにちは<|end|>"
        "<|assistant|>"
    )


def test_echo_translator_tags_by_source_language():
    translator = EchoTranslator()

    assert translator.translate("hi", "ja", "en") == "[EN] hi"
    assert translator.translate("hi", "en", "ja") == "[JA] hi"


def test_echo_translator_empty_text_returns_empty():
    assert EchoTranslator().translate("   ", "ja", "en") == ""


def test_genie_translator_rejects_unconfigured_language_pair(metadata_path: Path):
    translator = GenieTranslator(
        genie_config_path="unused.json", chat_template_path=metadata_path
    )

    with pytest.raises(ValueError):
        translator.translate("bonjour", "fr", "en")


def test_genie_translator_invokes_cli_and_parses_stdout(monkeypatch, metadata_path: Path):
    captured = {}

    def fake_run(cmd, capture_output, text, timeout, check):
        captured["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0, stdout="  Hello there  \n", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)

    translator = GenieTranslator(
        genie_config_path="genie_config.json",
        chat_template_path=metadata_path,
        executable="genie-t2t-run.exe",
    )
    result = translator.translate("こんにちは", "ja", "en")

    assert result == "Hello there"
    assert captured["cmd"][0] == "genie-t2t-run.exe"
    assert "--config" in captured["cmd"]
    assert "genie_config.json" in captured["cmd"]
    assert "--prompt" in captured["cmd"]


def test_genie_translator_empty_text_skips_subprocess(monkeypatch, metadata_path: Path):
    def fail_if_called(*args, **kwargs):
        raise AssertionError("subprocess.run should not be called for empty text")

    monkeypatch.setattr(subprocess, "run", fail_if_called)

    translator = GenieTranslator(
        genie_config_path="genie_config.json", chat_template_path=metadata_path
    )
    assert translator.translate("   ", "ja", "en") == ""


class _FakeMessages:
    def __init__(self, response_text: str, captured: dict) -> None:
        self._response_text = response_text
        self._captured = captured

    def create(self, **kwargs):
        self._captured.update(kwargs)
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=self._response_text)]
        )


def _fake_anthropic_client(response_text: str, captured: dict):
    class FakeClient:
        def __init__(self, **kwargs) -> None:
            captured["client_kwargs"] = kwargs
            self.messages = _FakeMessages(response_text, captured)

    return FakeClient


def test_claude_translator_calls_api_and_extracts_text(monkeypatch):
    import anthropic

    captured: dict = {}
    monkeypatch.setattr(
        anthropic, "Anthropic", _fake_anthropic_client("Hello there", captured)
    )

    translator = ClaudeTranslator(api_key="test-key", model="claude-haiku-4-5-20251001")
    result = translator.translate("こんにちは", "ja", "en")

    assert result == "Hello there"
    assert captured["system"] == TRANSLATION_SYSTEM_PROMPTS[("ja", "en")]
    assert captured["messages"] == [{"role": "user", "content": "こんにちは"}]
    assert captured["model"] == "claude-haiku-4-5-20251001"
    assert captured["client_kwargs"]["api_key"] == "test-key"


def test_claude_translator_rejects_unconfigured_language_pair(monkeypatch):
    import anthropic

    monkeypatch.setattr(anthropic, "Anthropic", _fake_anthropic_client("x", {}))
    translator = ClaudeTranslator(api_key="test-key")

    with pytest.raises(ValueError):
        translator.translate("bonjour", "fr", "en")


def test_claude_translator_empty_text_skips_api_call(monkeypatch):
    import anthropic

    def fail_if_called(**kwargs):
        raise AssertionError("messages.create should not be called for empty text")

    class FakeClient:
        def __init__(self, **kwargs) -> None:
            self.messages = SimpleNamespace(create=fail_if_called)

    monkeypatch.setattr(anthropic, "Anthropic", FakeClient)
    translator = ClaudeTranslator(api_key="test-key")

    assert translator.translate("   ", "ja", "en") == ""


def test_fallback_translator_uses_primary_when_it_succeeds():
    class AlwaysFails:
        def translate(self, text, source_lang, target_lang):
            raise AssertionError("secondary should not be called")

    class Primary:
        def translate(self, text, source_lang, target_lang):
            return "primary result"

    translator = FallbackTranslator(primary=Primary(), secondary=AlwaysFails())
    assert translator.translate("hi", "ja", "en") == "primary result"


def test_fallback_translator_falls_back_on_primary_error():
    class Primary:
        def translate(self, text, source_lang, target_lang):
            raise ConnectionError("no network")

    class Secondary:
        def translate(self, text, source_lang, target_lang):
            return "secondary result"

    translator = FallbackTranslator(primary=Primary(), secondary=Secondary())
    assert translator.translate("hi", "ja", "en") == "secondary result"
