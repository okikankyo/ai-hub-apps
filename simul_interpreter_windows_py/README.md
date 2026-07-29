## Real-time Simultaneous Interpreter for Snapdragon X Elite (dual-display)

A face-to-face speech interpreter for tourism and other in-person use cases: one
Snapdragon X Elite/X2 Elite Windows PC drives **two displays** --

* **Self display** (facing the Japanese speaker): control panel with a
  push-to-talk button per language, your own utterance, the translation the
  other person heard, and a **meaning-confirmation** line (back-translation).
* **Guest display** (facing the foreign visitor): the same conversation, but
  laid out from their point of view.

Speech recognition runs on-device with Whisper via ONNX Runtime + QNN (the
Snapdragon NPU) -- the same model family as [`../whisper_windows_py`](../whisper_windows_py).
This is not swappable at the CLI level: ASR always runs on the NPU.

Translation is swappable, since there is no ready-made machine-translation
model in Qualcomm AI Hub Models today:

* `genie` (default) -- fully on-device/NPU, via an LLM run through the Genie
  SDK (the same generative-AI path as [`../chatapp_android`](../chatapp_android)).
  No network needed; translation quality is bounded by the small LLM you can
  fit on-device (e.g. Llama 3.2 3B Instruct).
* `claude` -- calls the Claude API over the network instead. Better
  translation quality, but needs connectivity and doesn't touch the NPU at
  all -- Claude's weights aren't available to compile for QNN, so this mode
  is a cloud call, not on-device inference.
* `hybrid` -- tries `claude` first, falls back to `genie` if the API call
  fails (no signal, timeout, auth error). Matches the reality of a tourist
  site: use the better cloud translation when there's signal, keep working
  offline when there isn't.
* `echo` -- no real translation, see "Trying it without Genie/QAIRT" below.

### How the "meaning confirmation" feature works

There's no cheap way to verify semantic equivalence on-device without another
heavyweight model, so instead each translation is **translated back** into the
original language and shown next to what was actually said. A simple
string-similarity score (see `interpreter/conversation.py: similarity()`)
between the original and the round-trip text is bucketed into
high/medium/low confidence and color-coded, so the speaker can eyeball whether
their meaning likely survived the trip -- not a guarantee, but a useful sanity
check for a device used with strangers in a tourist setting.

## Architecture

```
                push-to-talk               ConversationSession
 mic  ───────▶  AudioRecorder  ──audio──▶  WhisperTranscriber (NPU)
                                                  │ text (ja or en)
                                                  ▼
                                         GenieTranslator (NPU LLM)
                                          │ translated text        │ back-translated text
                                          ▼                        ▼
                              InterpreterApp (Tk, 2 windows)   confirmation_level()
                                          │
                                          ▼
                                   Speaker (SAPI5 TTS)
```

* `interpreter/asr.py` -- `WhisperTranscriber`, wrapping `qai_hub_models`'
  `HfWhisperApp` (precompiled QNN ONNX), same as `whisper_windows_py/demo.py`.
* `interpreter/translate.py` -- `Translator` protocol; `GenieTranslator`
  (shells out to the QAIRT SDK's `genie-t2t-run` CLI, on-device/NPU),
  `ClaudeTranslator` (Claude API, cloud), `FallbackTranslator` (Claude with a
  Genie fallback), and `EchoTranslator` (a no-model dev/test stand-in).
* `interpreter/tts.py` -- `Speaker`, playing translated text through installed
  Windows SAPI5 voices on a background thread.
* `interpreter/conversation.py` -- `ConversationSession`, `Turn`, and the
  back-translation confirmation heuristic.
* `interpreter/display_layout.py` -- monitor detection (`screeninfo`) to place
  the two windows on the two physical displays.
* `gui/app_window.py` -- the Tkinter dual-window UI and push-to-talk recording.
* `demo.py` -- CLI entry point wiring everything together.

## Requirements

* A Windows 11 PC with a Snapdragon X Elite or X2 Elite chipset.
* Two displays (e.g. the laptop panel + an external monitor plugged in, or two
  monitors on a kiosk build), plus a microphone and speakers.
* [QAIRT SDK](https://qpm.qualcomm.com/#/main/tools/details/Qualcomm_AI_Runtime_SDK)
  installed, providing `genie-t2t-run.exe` and the QNN ONNX Runtime execution
  provider.
* An LLM exported for Genie (e.g. Llama 3.2 3B Instruct) from
  [AI Hub Models](https://aihub.qualcomm.com/models?domain=Generative+AI&useCase=Text+Generation),
  set up the same way as `../chatapp_android` (`genie_config.json` +
  `metadata.json` + tokenizer + `.bin` context files). This app reads the same
  `metadata.json.genie.chat_template` block that `chatapp_android`'s
  `PromptHandler.cpp` uses.

## Setup

1. Enable PowerShell Scripts (admin PowerShell):

   ```powershell
   Set-ExecutionPolicy -Scope CurrentUser Unrestricted -Force
   ```

2. Install platform dependencies (Anaconda, Git):

   ```powershell
   .\install_platform_deps.ps1 -extra_pkgs ffmpeg
   ```

3. Create & activate your Python environment:

   ```powershell
   .\activate_venv.ps1 -name AI_Hub_Interpreter
   ```

4. Install Python dependencies (Whisper + this app's extras: `screeninfo`,
   `pyttsx3`):

   ```powershell
   .\install_python_deps.ps1 -model whisper-base
   ```

5. Export the Whisper model for QNN, exactly as in `../whisper_windows_py`
   (see [its README](../whisper_windows_py/README.md) step 7 for the full
   command), placing the result at `models\whisper\encoder.onnx` /
   `models\whisper\decoder.onnx`.

6. Obtain a Genie-compiled LLM and place `genie_config.json`, `metadata.json`,
   the tokenizer, and the `.bin` context files under `models\llm\` --
   following the same steps as `../chatapp_android`'s
   ["Exporting an LLM"](../chatapp_android/README.md) section. Update
   `genie_config.json`'s `<models_path>`/`<tokenizer_path>` placeholders to
   point at `models\llm\`.

7. Find your microphone and a Japanese/English TTS voice:

   ```powershell
   python demo.py --list-audio-devices
   python demo.py --list-voices
   ```

   Windows ships English voices by default; install a Japanese SAPI5 voice
   ("Settings > Time & Language > Language & region > Add a language > Japanese",
   with speech enabled) if one isn't already present.

## Running

```powershell
python demo.py `
  --genie-config-path models\llm\genie_config.json `
  --genie-chat-template-path models\llm\metadata.json `
  --ja-voice-id "<id from --list-voices>" `
  --en-voice-id "<id from --list-voices>"
```

This opens two windows and places them on your two displays automatically
(`screeninfo` picks display index 1 for the guest window by default -- pass
`--guest-monitor-index` to change that). Drag the guest window to the correct
physical monitor first if Windows enumerates them in an unexpected order.

Each window has one push-to-talk button. Tap it, speak, tap again to stop --
the utterance is transcribed, translated, spoken aloud on the other side, and
both windows update with the original text, the translation, and (on the
speaker's own window) the back-translation confirmation line.

### Using Claude for translation instead of (or alongside) Genie

```powershell
$env:ANTHROPIC_API_KEY = "<your key>"
python demo.py --translator hybrid `
  --genie-config-path models\llm\genie_config.json `
  --genie-chat-template-path models\llm\metadata.json
```

`--translator claude` skips Genie entirely (no `models\llm\` setup needed,
but requires network); `--translator hybrid` keeps Genie configured as a
fallback for when the guest device has no signal. `--claude-api-key` is also
accepted as a flag instead of the environment variable.

### Trying it without Genie/QAIRT set up

```powershell
python demo.py --translator echo
```

`EchoTranslator` doesn't actually translate (it just tags the text), but it
lets you exercise the whole pipeline -- mic capture, Whisper transcription,
dual-window rendering, TTS, back-translation confidence coloring -- without a
compiled LLM.

## What's been verified vs. what needs real hardware

This app was developed and its logic tested in an environment without a
Snapdragon device attached, so be aware of the boundary between what's been
exercised and what hasn't:

* **Verified in that environment:** `ConversationSession`/`Turn`/confirmation
  scoring, `ChatTemplate` prompt assembly, `EchoTranslator`, `GenieTranslator`'s
  subprocess/prompt-building logic (with `subprocess.run` mocked),
  `ClaudeTranslator`'s request/response handling (with the `anthropic` client
  mocked) and `FallbackTranslator`'s fallback behavior, monitor-layout
  detection/fallback, and the full Tkinter dual-window UI (built, rendered a
  turn, ran the push-to-talk state machine) -- all with `pytest` and a
  fake ASR/translator/recorder, run under Xvfb. See `tests/`.
  A real `--translator claude` call against the live Claude API was **not**
  made in that environment (no API key was used/should be committed here),
  so the request-shape assumptions (`messages.create(model=, max_tokens=,
  system=, messages=)`, text extracted from `response.content`) are backed
  by inspecting the installed `anthropic` SDK, not a live call.
* **Not runnable without a Snapdragon X Elite Windows machine:** the actual
  QNN-accelerated Whisper inference, the `genie-t2t-run` subprocess against a
  real compiled LLM, and SAPI5 TTS. In particular, `GenieTranslator` assumes
  `genie-t2t-run --config <path> --prompt <text>` and treats stdout as the
  response; **check `genie-t2t-run --help` against your installed QAIRT SDK
  version** and adjust `--genie-executable`/`config_flag`/`prompt_flag`, or
  pass a custom `response_parser` to `GenieTranslator`, if it differs.

## Limitations

* Fixed Japanese <-> English language pair (by design, for this first
  version -- see `interpreter/conversation.py: LANGUAGE_PAIR` to extend it).
* One speaker at a time: pressing the other side's button while one person is
  recording is ignored.
* The confirmation score is a coarse string-similarity heuristic, not a
  semantic check -- treat "low" as "worth double-checking," not "wrong."
* TTS uses whatever SAPI5 voices are installed on Windows; there's no
  NPU-accelerated TTS model available yet to swap in.
* `--translator claude`/`hybrid` sends conversation text to Anthropic's API;
  don't use it for conversations that need to stay fully offline/on-device.
