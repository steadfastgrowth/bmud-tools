# B-Mud STT (Wispr / Granola–class dictation)

Flip side-button capture → Mac relay → high-quality transcription → optional Grok polish → insert into focused field.

## Why this upgrade

Stock path was **Whisper `base` on Mini** — fine for demos, not close to Wispr Flow / Granola.

| Layer | Before | After |
|-------|--------|--------|
| ASR model | Whisper base (~74M) | **mlx Whisper large-v3-turbo** on Apple Silicon |
| Cleanup | raw tokens | **Grok polish** (fillers, punctuation, self-corrections) |
| Vocabulary | none | `~/.config/bmud/stt_vocab.txt` |
| Phone mic | default | noise suppression + AGC + mono |

## Pipeline

```
2780 MediaRecorder (webm/3gp)
  → POST /v1/stt  (Mac relay :8790)
  → ffmpeg → 16 kHz mono WAV
  → mlx-whisper large-v3-turbo  (or OpenAI if key set)
  → Grok polish via Mini /v1/chat  (optional, STT_POLISH=1)
  → { text, raw_text, polished, engine, model, elapsed_s }
```

## Engines (`STT_ENGINE`)

| Value | Behavior |
|-------|----------|
| `auto` (default) | OpenAI if `OPENAI_API_KEY`, else **local** mlx, else Mini base |
| `local` | Always mlx-whisper on this Mac |
| `openai` | `gpt-4o-transcribe` (or `OPENAI_STT_MODEL`) |
| `mini` | Old Whisper-base proxy |

### Optional OpenAI (closest to commercial dictation)

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_STT_MODEL=gpt-4o-transcribe   # or whisper-1
export STT_ENGINE=auto   # picks OpenAI first
```

## Env (run-pocket-relay.sh)

```bash
STT_ENGINE=auto
STT_MODEL=mlx-community/whisper-large-v3-turbo
STT_PYTHON=~/.local/share/bmud-stt/bin/python
STT_POLISH=1
STT_VOCAB=~/.config/bmud/stt_vocab.txt
FFMPEG=/opt/homebrew/bin/ffmpeg
```

## Vocabulary

Edit `~/.config/bmud/stt_vocab.txt` — one term per line. Used as Whisper `initial_prompt` and polish context (names, brands, slang).

## API

`POST /v1/stt?language=en&polish=1`

Multipart fields: `audio` or `file` (phone sends both).

Response:

```json
{
  "ok": true,
  "text": "Polished sentence ready to send.",
  "raw_text": "um polished sentence ready to send",
  "polished": true,
  "engine": "local",
  "model": "mlx-community/whisper-large-v3-turbo",
  "elapsed_s": 1.8
}
```

## Install (Mac)

```bash
brew install ffmpeg
python3 -m venv ~/.local/share/bmud-stt
~/.local/share/bmud-stt/bin/pip install -U mlx-whisper
# first run downloads the model (~1.5GB)
```

## Phone UX

1. Focus a text field (notes, messages, AI, maps, terminal…)
2. **SIDE button** (or Talk) → speak
3. SIDE again → transcribe + polish → insert

## Honest limits

- Not a real-time streaming overlay like desktop Wispr; still **push-to-talk**.
- Polish needs Mini Grok (`MINI_BRIDGE`) online.
- KaiOS mic + cellular noise still matter — speak clearly, short clips win.
- Full interactive TTY tools are unrelated; STT is for **text fields**.
