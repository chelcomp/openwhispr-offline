# Network Allowlist

Outbound hosts the EktosWhispr desktop app contacts. For firewall, proxy, and
DNS filter configuration.

All connections are client-initiated over TLS. No inbound ports.

This is an offline-first fork: there is no first-party EktosWhispr Cloud
backend (no `api.ektoswhispr.com`/`auth.ektoswhispr.com`), and Google
Calendar integration has been removed from the codebase. Every host below is
either always-on infrastructure (auto-update) or opt-in, tied to a specific
feature the user has explicitly enabled or configured.

## Required by default

| Host                                          | Protocol | Port | Purpose                                                                            |
| --------------------------------------------- | -------- | ---- | ---------------------------------------------------------------------------------- |
| `github.com`, `objects.githubusercontent.com` | HTTPS    | 443  | Application auto-update (release artifacts via electron-updater, GitHub provider). |

## Required for streaming transcription

Meeting transcription routes streaming sessions through one of three BYOK
providers. Allowlist all three unless a specific provider is pinned in
configuration.

| Host                       | Protocol   | Port | Purpose                                                                           |
| -------------------------- | ---------- | ---- | --------------------------------------------------------------------------------- |
| `api.deepgram.com`         | WSS        | 443  | Deepgram streaming transcription.                                                 |
| `api.openai.com`           | WSS, HTTPS | 443  | OpenAI Realtime streaming transcription.                                          |
| `streaming.assemblyai.com` | WSS, HTTPS | 443  | AssemblyAI streaming transcription. Token endpoint is HTTPS; live session is WSS. |

## Required for local model downloads

Contacted only when a user opts into a local model (Whisper, Parakeet, or a
local GGUF reasoning model). Not required otherwise.

| Host                                                    | Protocol | Port | Purpose                                                                                                                                                                     |
| ------------------------------------------------------- | -------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `huggingface.co`                                        | HTTPS    | 443  | Whisper GGML, Parakeet, and GGUF model downloads.                                                                                                                           |
| `cdn-lfs.huggingface.co`, `cdn-lfs-us-1.huggingface.co` | HTTPS    | 443  | HuggingFace large-file CDN (LFS-backed model files).                                                                                                                        |
| `github.com`, `objects.githubusercontent.com`           | HTTPS    | 443  | sherpa-onnx, llama.cpp, and whisper.cpp binaries (GitHub releases). Also `windows-active-window-info.exe` (active-window screen-context capture helper, see CLAUDE.md §20). |
| `cdn.jsdelivr.net`                                      | HTTPS    | 443  | Tesseract.js OCR WASM core, downloaded only when the user enables the active-window screen-context feature and selects/falls back to the Tesseract OCR engine (§20).        |
| `raw.githubusercontent.com`                             | HTTPS    | 443  | Tesseract.js's `eng.traineddata` OCR language-data file (same feature/trigger as above).                                                                                    |

## BYOK provider hosts (only if configured)

Required only when a user configures their own API key for the corresponding
provider. Skip any provider not in use.

| Host                                                                             | Protocol   | Port | Used when                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------- | ---------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.openai.com`                                                                 | HTTPS      | 443  | OpenAI API key configured (transcription or reasoning).                                                                                                                                                                                                                                                                                                  |
| `*.cognitiveservices.azure.com`, `*.openai.azure.com`, `*.services.ai.azure.com` | HTTPS      | 443  | Azure AI Foundry / Azure OpenAI speech-to-text configured (custom transcription provider pointed at your own Azure resource endpoint).                                                                                                                                                                                                                   |
| `api.anthropic.com`                                                              | HTTPS      | 443  | Anthropic API key configured.                                                                                                                                                                                                                                                                                                                            |
| `generativelanguage.googleapis.com`                                              | HTTPS      | 443  | Gemini API key configured.                                                                                                                                                                                                                                                                                                                               |
| `api.groq.com`                                                                   | HTTPS      | 443  | Groq API key configured.                                                                                                                                                                                                                                                                                                                                 |
| `atc.tinfoil.sh`, `*.tinfoil.sh`                                                 | WSS, HTTPS | 443  | Tinfoil API key configured. `atc.tinfoil.sh` serves the enclave attestation bundle (verified locally against an embedded sigstore root). Inference and realtime transcription connect to an enclave host assigned dynamically at runtime (e.g. `inference.tinfoil.sh`, `router.infN.tinfoil.sh`), so allowlist `*.tinfoil.sh` rather than pinning hosts. |
| `api.mistral.ai`                                                                 | HTTPS      | 443  | Mistral API key configured.                                                                                                                                                                                                                                                                                                                              |
| `openrouter.ai`                                                                  | HTTPS      | 443  | OpenRouter selected as a reasoning provider (`/api/v1/models` is fetched even without a key).                                                                                                                                                                                                                                                            |

## Notes

- The app uses Electron's network stack, which honors system proxy settings
  (macOS System Settings, Windows Internet Options / WPAD, GNOME proxy) and
  PAC scripts on all platforms.
- Connections fail with `ENOTFOUND` if DNS is filtered, `ECONNREFUSED` /
  `ETIMEDOUT` if a firewall blocks the host, and `CERT_HAS_EXPIRED` /
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE` if a TLS-intercepting proxy is in the
  path without its root certificate trusted by the OS.
- IP-pinning is not supported. The hosts above resolve to provider-managed
  IPs that change without notice.
- On minimal Linux containers without a system CA bundle (Alpine, distroless),
  set `NODE_EXTRA_CA_CERTS` to your CA bundle path so corporate TLS interception
  is trusted.

## How to test

Run from a machine on the same network as the user. A successful response
(any HTTP status, including `401`) confirms the network path works.

```sh
# Auto-update
curl -v -I https://github.com

# Streaming providers (only if a BYOK streaming provider is configured)
curl -v https://api.deepgram.com/v1/projects
curl -v https://api.openai.com/v1/models
curl -v https://streaming.assemblyai.com/v3/token

# Model downloads (only if local mode is in use)
curl -v -I https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin
```

If a request returns `Could not resolve host`, the DNS layer (resolver,
filter, or ad blocker) is blocking the domain. If it hangs or returns
`Connection refused`, a firewall is blocking the port. If it returns a TLS
error, a proxy is intercepting the connection without a trusted root.
