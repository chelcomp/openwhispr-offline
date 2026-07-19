const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");

// PowerShell fallback for when nircmd.exe isn't bundled/found. Talks to the
// Windows Core Audio API (IMMDeviceEnumerator / IAudioEndpointVolume) directly
// via COM interop so muting doesn't depend on any external binary.
//
// All COM activation/casting happens inside the compiled C# helper — the
// C# compiler special-cases `new` on a [ComImport] class (CoCreateInstance)
// and interface casts on RCWs (QueryInterface). Doing the same casts from
// PowerShell's reflection-driven New-Object/cast operators doesn't trigger
// that special-casing and fails with an InvalidCastException.
const MIC_MUTE_HELPER_SOURCE = `
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int NotImpl_EnumAudioEndpoints();
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
}

[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int NotImpl_RegisterControlChangeNotify();
  int NotImpl_UnregisterControlChangeNotify();
  int NotImpl_GetChannelCount();
  int NotImpl_SetMasterVolumeLevel();
  int NotImpl_SetMasterVolumeLevelScalar();
  int NotImpl_GetMasterVolumeLevel();
  int NotImpl_GetMasterVolumeLevelScalar();
  int NotImpl_SetChannelVolumeLevel();
  int NotImpl_SetChannelVolumeLevelScalar();
  int NotImpl_GetChannelVolumeLevel();
  int NotImpl_GetChannelVolumeLevelScalar();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
}

public static class EktosWhisprMicMuteHelper {
  static IAudioEndpointVolume GetEndpointVolume() {
    var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice device;
    // dataFlow: eCapture = 1, role: eMultimedia = 1 (matches the Recording tab's Default Device)
    enumerator.GetDefaultAudioEndpoint(1, 1, out device);
    Guid iid = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
    object epvObj;
    // dwClsCtx: CLSCTX_ALL = 23
    device.Activate(ref iid, 23, IntPtr.Zero, out epvObj);
    return (IAudioEndpointVolume)epvObj;
  }

  public static void SetMute(bool mute) {
    var epv = GetEndpointVolume();
    Guid ctx = Guid.Empty;
    epv.SetMute(mute, ref ctx);
  }

  public static bool GetMute() {
    var epv = GetEndpointVolume();
    bool muted;
    epv.GetMute(out muted);
    return muted;
  }
}
`;

// A fresh `powershell.exe -Command` invocation costs ~1-1.3s just to start the
// host and JIT-compile the inline C# above — regardless of how trivial the
// call is — measured via repeated cold spawns. Paying that once per mute/unmute
// (as the previous one-shot-process implementation did) is the dominant cost
// behind the "long pause before the start beep" reports. This long-lived
// helper process compiles the C# ONCE and then answers line-based commands
// over its own stdin/stdout, so every call after the first is a ~1-5ms round
// trip instead of a full process spawn.
const PERSISTENT_HELPER_SCRIPT = `
$ErrorActionPreference = "Stop"
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput())
$stdout.AutoFlush = $true
[Console]::SetOut($stdout)

Add-Type -TypeDefinition @"
${MIC_MUTE_HELPER_SOURCE}
"@

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    if ($line -eq "GET_MUTE") {
      $muted = [EktosWhisprMicMuteHelper]::GetMute()
      Write-Output "RESULT GET_MUTE $muted"
    } elseif ($line -eq "SET_MUTE true") {
      [EktosWhisprMicMuteHelper]::SetMute($true)
      Write-Output "RESULT SET_MUTE true"
    } elseif ($line -eq "SET_MUTE false") {
      [EktosWhisprMicMuteHelper]::SetMute($false)
      Write-Output "RESULT SET_MUTE false"
    } else {
      Write-Output "RESULT ERROR unknown_command"
    }
  } catch {
    $msg = $_.Exception.Message -replace "\`r?\`n", " "
    Write-Output "RESULT ERROR $msg"
  }
}
`;

class MicMuteManager {
  constructor() {
    this.nircmdPath = null;
    this.nircmdChecked = false;
    this.helperProcess = null;
    this.helperStartupPromise = null;
    this.helperStdoutBuffer = "";
    this.pendingHelperRequests = [];
  }

  getNircmdPath() {
    if (this.nircmdChecked) {
      return this.nircmdPath;
    }
    this.nircmdChecked = true;

    const possiblePaths = [
      ...(process.resourcesPath ? [path.join(process.resourcesPath, "bin", "nircmd.exe")] : []),
      path.join(__dirname, "..", "..", "resources", "bin", "nircmd.exe"),
      path.join(process.cwd(), "resources", "bin", "nircmd.exe"),
    ];

    for (const candidate of possiblePaths) {
      try {
        if (fs.existsSync(candidate)) {
          this.nircmdPath = candidate;
          return candidate;
        }
      } catch {
        // Keep checking other candidates.
      }
    }
    return null;
  }

  // Call at app startup (gated on the auto-unmute setting) to pay the one-time
  // PowerShell+C# compile cost in the background instead of on the user's
  // first dictation.
  warmUp() {
    if (process.platform !== "win32") return Promise.resolve();
    return this._getHelperProcess().catch((error) => {
      debugLogger.debug("[MicMute] Helper pre-warm failed (non-fatal)", { error: error.message }, "audio");
    });
  }

  stop() {
    if (this.helperProcess) {
      try {
        this.helperProcess.stdin.end();
        this.helperProcess.kill();
      } catch {
        // Ignore — process may already be gone.
      }
      this.helperProcess = null;
    }
  }

  _getHelperProcess() {
    if (this.helperProcess) return Promise.resolve(this.helperProcess);
    if (this.helperStartupPromise) return this.helperStartupPromise;

    this.helperStartupPromise = this._spawnHelperProcess().finally(() => {
      this.helperStartupPromise = null;
    });
    return this.helperStartupPromise;
  }

  _spawnHelperProcess() {
    return new Promise((resolve, reject) => {
      const proc = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", PERSISTENT_HELPER_SCRIPT],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
      );

      let settled = false;
      this.helperStdoutBuffer = "";

      proc.stdout.on("data", (data) => {
        this.helperStdoutBuffer += data.toString();
        let idx;
        while ((idx = this.helperStdoutBuffer.indexOf("\n")) !== -1) {
          const line = this.helperStdoutBuffer.slice(0, idx).trim();
          this.helperStdoutBuffer = this.helperStdoutBuffer.slice(idx + 1);
          if (line.startsWith("RESULT ") && this.pendingHelperRequests.length) {
            const { resolve: resolveRequest } = this.pendingHelperRequests.shift();
            resolveRequest(line.slice("RESULT ".length));
          }
        }
      });

      proc.stderr.on("data", (data) => {
        debugLogger.debug("[MicMute] helper stderr", { data: data.toString().trim() }, "audio");
      });

      proc.on("spawn", () => {
        settled = true;
        this.helperProcess = proc;
        resolve(proc);
      });

      proc.on("exit", (code) => {
        debugLogger.debug("[MicMute] helper process exited", { code }, "audio");
        this.helperProcess = null;
        const pending = this.pendingHelperRequests.splice(0, this.pendingHelperRequests.length);
        for (const { reject: rejectRequest } of pending) {
          rejectRequest(new Error(`MicMute helper exited (code ${code})`));
        }
      });

      proc.on("error", (error) => {
        debugLogger.warn("[MicMute] helper process error", { error: error.message }, "audio");
        this.helperProcess = null;
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    });
  }

  async _sendHelperCommand(command) {
    const proc = await this._getHelperProcess();
    return new Promise((resolve, reject) => {
      this.pendingHelperRequests.push({ resolve, reject });
      proc.stdin.write(command + "\n", (err) => {
        if (err) {
          debugLogger.warn("[MicMute] helper stdin write failed", { error: err.message }, "audio");
        }
      });
    });
  }

  async getMuted() {
    if (process.platform !== "win32") {
      debugLogger.debug(
        "[MicMute] Unsupported platform, skipping",
        { platform: process.platform },
        "audio"
      );
      return { success: false, error: "Unsupported platform" };
    }

    try {
      const result = await this._sendHelperCommand("GET_MUTE");
      const match = result.match(/^GET_MUTE (True|False)$/i);
      if (match) {
        const muted = match[1].toLowerCase() === "true";
        debugLogger.debug("[MicMute] get mute", { muted }, "audio");
        return { success: true, muted };
      }
      debugLogger.warn("[MicMute] get mute failed", { result }, "audio");
      return { success: false, error: result };
    } catch (error) {
      debugLogger.warn("[MicMute] get mute error", { error: error.message }, "audio");
      return { success: false, error: error.message };
    }
  }

  async setMuted(muted) {
    if (process.platform !== "win32") {
      debugLogger.debug(
        "[MicMute] Unsupported platform, skipping",
        { platform: process.platform },
        "audio"
      );
      return { success: false, error: "Unsupported platform" };
    }

    const nircmdPath = this.getNircmdPath();
    if (nircmdPath) {
      return this._setMutedNircmd(nircmdPath, muted);
    }
    return this._setMutedHelper(muted);
  }

  _setMutedNircmd(nircmdPath, muted) {
    return new Promise((resolve) => {
      const proc = spawn(nircmdPath, ["mutesysvolume", muted ? "1" : "0", "microphone"], {
        windowsHide: true,
      });

      proc.on("close", (code) => {
        if (code === 0) {
          debugLogger.debug("[MicMute] nircmd set mute", { muted }, "audio");
          resolve({ success: true });
        } else {
          debugLogger.warn(
            "[MicMute] nircmd failed, falling back to helper",
            { code },
            "audio"
          );
          this._setMutedHelper(muted).then(resolve);
        }
      });

      proc.on("error", (error) => {
        debugLogger.warn(
          "[MicMute] nircmd error, falling back to helper",
          { error: error.message },
          "audio"
        );
        this._setMutedHelper(muted).then(resolve);
      });
    });
  }

  async _setMutedHelper(muted) {
    try {
      const result = await this._sendHelperCommand(`SET_MUTE ${muted ? "true" : "false"}`);
      if (result === `SET_MUTE ${muted ? "true" : "false"}`) {
        debugLogger.debug("[MicMute] set mute", { muted }, "audio");
        return { success: true };
      }
      debugLogger.warn("[MicMute] set mute failed", { result }, "audio");
      return { success: false, error: result };
    } catch (error) {
      debugLogger.warn("[MicMute] set mute error", { error: error.message }, "audio");
      return { success: false, error: error.message };
    }
  }
}

module.exports = new MicMuteManager();
