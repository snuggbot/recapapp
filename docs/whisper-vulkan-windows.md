# AMD Vulkan Whisper setup

This is the product-quality local transcription path for the Windows 11 main rig:

- AMD Radeon RX 9070 XT (16 GB VRAM)
- Ryzen 7 7800X3D
- 32 GB RAM

The current CTranslate2/faster-whisper server is CPU-oriented on this AMD/Windows
setup. The Vulkan path keeps the large-v3-turbo quality target and uses whisper.cpp.

## Build whisper.cpp on the rig

Install Git, CMake, Ninja, and the Visual Studio 2022 C++ build tools. Then run in
PowerShell:

```powershell
git clone https://github.com/ggerganov/whisper.cpp.git C:\whisper.cpp
cd C:\whisper.cpp
cmake -S . -B build -G Ninja `
  -DGGML_VULKAN=ON `
  -DWHISPER_BUILD_SERVER=ON `
  -DWHISPER_BUILD_EXAMPLES=ON
cmake --build build --config Release --target whisper-server
```

Check `whisper-server.exe --help` after building. If the pinned revision uses a
different server target or option spelling, follow that help output; `GGML_VULKAN=ON`
is the important backend flag.

## Download the model

Download the whisper.cpp model format, not the old CTranslate2 model directory:

```powershell
New-Item -ItemType Directory -Force C:\whisper.cpp\models | Out-Null
Invoke-WebRequest `
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin?download=true" `
  -OutFile C:\whisper.cpp\models\ggml-large-v3-turbo.bin
```

Keep the existing CTranslate2 model until the Vulkan canary passes. Delete it only
after the new endpoint has produced correct timestamped segments.

## Start the server

Use the project helper from a copy of this repository, or run the equivalent command:

```powershell
C:\workspace\stream-recap\scripts\run-whisper-vulkan.ps1
```

The helper starts whisper.cpp on port `1235` so the old faster-whisper service can
remain available for rollback. Confirm the server startup output identifies Vulkan
and the RX 9070 XT. A successful build alone does not prove that Vulkan is active.

## StreamRecap canary configuration

After the standalone `/inference` test succeeds, switch the machine-local `.env`:

```env
TRANSCRIPTION_PROVIDER=local
LOCAL_WHISPER_PROTOCOL=whisper-cpp
LOCAL_WHISPER_BASE_URL=http://192.168.4.21:1235
LOCAL_WHISPER_MODEL=ggml-large-v3-turbo.bin
LOCAL_WHISPER_LANGUAGE=en
TRANSCRIPTION_CONCURRENCY=1
```

The adapter posts to whisper.cpp's `/inference` endpoint and normalizes its JSON
segment timestamps (`timestamps`, `offsets`, or `t0/t1`) into StreamRecap's existing
transcript format. No frontend or recap-schema changes are required.

## Acceptance test

1. Post a 30–60 second speech clip to `/inference` and confirm non-empty JSON segments.
2. Confirm segment timestamps are monotonic and within the clip duration.
3. Confirm the server log identifies the Vulkan device.
4. Process one short Twitch/Kick VOD.
5. Process one long background job.
6. Compare quality and timing against the old faster-whisper output.

Keep concurrency at `1` until VRAM usage and throughput are measured. Roll back by
setting `LOCAL_WHISPER_PROTOCOL=openai` and pointing `LOCAL_WHISPER_BASE_URL` back at
the old faster-whisper port `1234`.
