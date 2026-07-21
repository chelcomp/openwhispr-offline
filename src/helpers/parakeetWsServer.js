const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const debugLogger = require("./debugLogger");
const os = require("os");
const {
  findAvailablePort,
  resolveBinaryPath,
  gracefulStopProcess,
} = require("../utils/serverUtils");
const { getSafeTempDir } = require("./safeTempDir");
const sidecarPidFile = require("./sidecarPidFile");
const { parseOfflineMessage } = require("./parakeetWsResult");

const PORT_RANGE_START = 6006;
const PORT_RANGE_END = 6029;
const STARTUP_TIMEOUT_MS = 60000;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const TRANSCRIPTION_TIMEOUT_MS = 300000;
// Drain-before-stop ceilings (R8). STREAMING_DRAIN_TIMEOUT_MS is retained for
// activeStreamCount's general shape (shared with whisperServer.js/llamaServer.js)
// even though no runtime ever increments activeStreamCount today — the
// online/streaming runtime that used to need the longer ceiling was removed
// entirely (see docs/specs/audio-transcription-batching.md).
const DRAIN_TIMEOUT_MS = 15000;
const STREAMING_DRAIN_TIMEOUT_MS = 300000;
// Default/fallback idle timeout — overridable at runtime via
// setIdleTimeoutMs(ms), fed by the `transcriptionIdleTimeoutMs` setting.
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

class ParakeetWsServer {
  constructor() {
    this.process = null;
    this.port = null;
    this.ready = false;
    this.modelName = null;
    this.modelDir = null;
    this.startupPromise = null;
    this.healthCheckInterval = null;
    this.modelRuntime = "offline";
    this.cachedBinaryPaths = {};
    // R5/R8: universal idle-timeout + drain-before-stop state, shared shape
    // with whisperServer.js/llamaServer.js.
    this.activeRequestCount = 0;
    this.activeStreamCount = 0;
    this.idleTimer = null;
    this.idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
    // Set right before any stop() this manager itself initiates, so the
    // process.on("close", ...) handler can log an unexpected exit distinctly
    // (R7) without ever scheduling a respawn.
    this._intentionalStop = false;
  }

  // Called whenever the `transcriptionIdleTimeoutMs` setting changes (and once
  // at startup-sync time); defaults to DEFAULT_IDLE_TIMEOUT_MS until then.
  setIdleTimeoutMs(ms) {
    this.idleTimeoutMs = Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_IDLE_TIMEOUT_MS;
  }

  resetIdleTimer() {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      debugLogger.info("parakeet-ws idle timeout reached, stopping", {
        timeoutMs: this.idleTimeoutMs,
      });
      this.stop();
    }, this.idleTimeoutMs);
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  // Waits for in-flight offline requests / open online streams to settle
  // before a stop() proceeds, so an idle-timeout/settings-switch stop never
  // corrupts a request that's actually in flight (R8). Offline requests get
  // the shorter DRAIN_TIMEOUT_MS ceiling; open streaming handles get the much
  // longer STREAMING_DRAIN_TIMEOUT_MS since a dictation can run well past 15s.
  async _drainActiveRequests() {
    const ceiling = this.activeStreamCount > 0 ? STREAMING_DRAIN_TIMEOUT_MS : DRAIN_TIMEOUT_MS;
    const start = Date.now();
    while (
      (this.activeRequestCount > 0 || this.activeStreamCount > 0) &&
      Date.now() - start < ceiling
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // `runtime` is retained as a parameter (always "offline" today) rather than
  // hardcoded, since ParakeetServerManager/ParakeetManager still pass it
  // through explicitly per model — see parakeetModelInfo.js's getModelRuntime().
  getWsBinaryPath(runtime = "offline") {
    if (this.cachedBinaryPaths[runtime]) return this.cachedBinaryPaths[runtime];

    const platformArch = `${process.platform}-${process.arch}`;
    const prefix = "sherpa-onnx-ws";

    if (process.env.SHERPA_ONNX_CUDA_ENABLED === "true") {
      const cudaName =
        process.platform === "win32"
          ? `${prefix}-${platformArch}-cuda.exe`
          : `${prefix}-${platformArch}-cuda`;
      const cudaResolved = resolveBinaryPath(cudaName);
      if (cudaResolved) {
        this.cachedBinaryPaths[runtime] = cudaResolved;
        return cudaResolved;
      }
      debugLogger.warn("CUDA binary not found, falling back to CPU binary", { cudaName });
    }

    const binaryName =
      process.platform === "win32" ? `${prefix}-${platformArch}.exe` : `${prefix}-${platformArch}`;

    const resolved = resolveBinaryPath(binaryName);
    if (resolved) this.cachedBinaryPaths[runtime] = resolved;
    return resolved;
  }

  invalidateBinaryCache() {
    this.cachedBinaryPaths = {};
  }

  // NVIDIA (Parakeet) transcription always runs on CUDA when the hardware and the
  // CUDA binary are both present. Unlike whisper-server there is no runtime
  // CPU fallback, so CUDA is only switched on when an NVIDIA GPU is actually
  // detected. Selecting CPU only ever applies to the OpenAI/Whisper engine —
  // NVIDIA models are never downgraded to CPU while a usable GPU is available.
  async _syncCudaSelection(runtime = "offline") {
    const wasEnabled = process.env.SHERPA_ONNX_CUDA_ENABLED === "true";
    const eligible = await this._isCudaEligible(runtime);
    if (eligible) {
      process.env.SHERPA_ONNX_CUDA_ENABLED = "true";
    } else {
      delete process.env.SHERPA_ONNX_CUDA_ENABLED;
    }
    // Binary paths are cached per runtime and depend on the CUDA flag, so drop
    // the cache whenever the resolved selection changes.
    if (eligible !== wasEnabled) this.invalidateBinaryCache();
  }

  async _isCudaEligible(runtime = "offline") {
    if (!this.isCudaBinaryAvailable(runtime)) return false;
    try {
      const { detectNvidiaGpu } = require("../utils/gpuDetection");
      const gpu = await detectNvidiaGpu();
      return !!gpu?.hasNvidiaGpu;
    } catch (err) {
      debugLogger.warn("Parakeet CUDA eligibility check failed; falling back to CPU", {
        error: err.message,
      });
      return false;
    }
  }

  isAvailable(runtime = "offline") {
    return this.getWsBinaryPath(runtime) !== null;
  }

  hasAnyWsBinary() {
    return this.isAvailable("offline");
  }

  isCudaBinaryAvailable(runtime = "offline") {
    const platformArch = `${process.platform}-${process.arch}`;
    const prefix = "sherpa-onnx-ws";
    const cudaName =
      process.platform === "win32"
        ? `${prefix}-${platformArch}-cuda.exe`
        : `${prefix}-${platformArch}-cuda`;
    return !!resolveBinaryPath(cudaName);
  }

  async start(modelName, modelDir, runtime = "offline") {
    if (this.startupPromise) return this.startupPromise;
    if (this.ready && this.modelName === modelName) return;
    if (this.process) await this.stop();

    await this._syncCudaSelection(runtime);

    this.startupPromise = this._doStart(modelName, modelDir, runtime);
    try {
      await this.startupPromise;
    } finally {
      this.startupPromise = null;
    }
  }

  async _doStart(modelName, modelDir, runtime) {
    const wsBinary = this.getWsBinaryPath(runtime);
    if (!wsBinary) throw new Error(`sherpa-onnx ${runtime} WS server binary not found`);
    if (!fs.existsSync(modelDir)) throw new Error(`Model directory not found: ${modelDir}`);

    this.port = await findAvailablePort(PORT_RANGE_START, PORT_RANGE_END);
    this.modelName = modelName;
    this.modelDir = modelDir;
    this.modelRuntime = runtime;

    const useCuda = process.env.SHERPA_ONNX_CUDA_ENABLED === "true";
    const threads = Math.max(1, Math.min(4, Math.floor(os.cpus().length * 0.75)));
    const args = [
      `--tokens=${path.join(modelDir, "tokens.txt")}`,
      `--encoder=${path.join(modelDir, "encoder.int8.onnx")}`,
      `--decoder=${path.join(modelDir, "decoder.int8.onnx")}`,
      `--joiner=${path.join(modelDir, "joiner.int8.onnx")}`,
      `--port=${this.port}`,
      `--num-threads=${useCuda ? 1 : threads}`,
      ...(useCuda ? ["--provider=cuda"] : []),
    ];

    const spawnEnv = { ...process.env };
    if (useCuda) {
      spawnEnv.CUDA_DEVICE_ORDER = "PCI_BUS_ID";
      if (process.env.TRANSCRIPTION_GPU_UUID) {
        spawnEnv.CUDA_VISIBLE_DEVICES = process.env.TRANSCRIPTION_GPU_UUID;
      }
    }

    debugLogger.debug("Starting parakeet WS server", {
      port: this.port,
      modelName,
      runtime,
      useCuda,
      args,
    });

    this._intentionalStop = false;
    this.process = spawn(wsBinary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      cwd: getSafeTempDir(),
      detached: process.platform !== "win32",
      env: spawnEnv,
    });
    sidecarPidFile.write("parakeet", this.process.pid);

    let stderrBuffer = "";
    let exitCode = null;
    let readyResolve = null;
    const readyFromStderr = new Promise((resolve) => {
      readyResolve = resolve;
    });

    this.process.stdout.on("data", (data) => {
      debugLogger.debug("parakeet-ws stdout", { data: data.toString().trim() });
    });

    this.process.stderr.on("data", (data) => {
      const chunk = data.toString();
      if (stderrBuffer.length < 65536) stderrBuffer += chunk;
      debugLogger.debug("parakeet-ws stderr", { data: chunk.trim() });
      if (chunk.includes("Listening on:")) {
        readyResolve(true);
      }
    });

    this.process.on("error", (error) => {
      debugLogger.error("parakeet-ws process error", { error: error.message });
      this.ready = false;
      readyResolve(false);
    });

    this.process.on("close", (code) => {
      exitCode = code;
      if (this._intentionalStop) {
        debugLogger.debug("parakeet-ws process exited", { code });
      } else {
        // R7 — no proactive respawn, ever: just log distinctly and let the
        // next on-demand start() (warm-up trigger or a real transcription
        // request) cold-start it normally.
        debugLogger.error("parakeet-ws exited unexpectedly (crash, not an intentional stop)", {
          code,
        });
      }
      this.ready = false;
      this.process = null;
      this.stopHealthCheck();
      this.clearIdleTimer();
      sidecarPidFile.clear("parakeet");
      readyResolve(false);
    });

    await this._waitForReady(readyFromStderr, () => ({ stderr: stderrBuffer, exitCode }));
    this._startHealthCheck();
    this.resetIdleTimer();

    debugLogger.info("parakeet-ws server started successfully", {
      port: this.port,
      model: modelName,
      runtime,
    });

    await this._warmUp();
  }

  async _warmUp() {
    try {
      const sampleRate = 16000;
      const numSamples = sampleRate;
      const silentSamples = Buffer.alloc(numSamples * 4);
      await this._transcribeOffline(silentSamples, sampleRate);
      debugLogger.debug("parakeet-ws warm-up inference complete");
    } catch (err) {
      debugLogger.warn("parakeet-ws warm-up failed (non-fatal)", {
        error: err.message,
      });
    }
  }

  async _waitForReady(readySignal, getProcessInfo) {
    const startTime = Date.now();

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`parakeet-ws failed to start within ${STARTUP_TIMEOUT_MS}ms`)),
        STARTUP_TIMEOUT_MS
      );
    });

    const ready = await Promise.race([readySignal, timeoutPromise]);

    if (!ready) {
      const info = getProcessInfo ? getProcessInfo() : {};
      const stderr = info.stderr ? info.stderr.trim().slice(0, 200) : "";
      const details = stderr || (info.exitCode !== null ? `exit code: ${info.exitCode}` : "");
      throw new Error(`parakeet-ws process died during startup${details ? `: ${details}` : ""}`);
    }

    this.ready = true;
    debugLogger.debug("parakeet-ws ready", { startupTimeMs: Date.now() - startTime });
  }

  _isProcessAlive() {
    if (!this.process || this.process.killed) return false;
    try {
      process.kill(this.process.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  _startHealthCheck() {
    this.stopHealthCheck();
    this.healthCheckInterval = setInterval(() => {
      if (!this.process) {
        this.stopHealthCheck();
        return;
      }

      if (!this._isProcessAlive()) {
        debugLogger.warn("parakeet-ws health check failed: process not alive");
        this.ready = false;
        this.stopHealthCheck();
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  transcribe(samplesBuffer, sampleRate) {
    if (!this.ready || !this.process) {
      throw new Error("parakeet-ws server is not running");
    }
    return this._transcribeOffline(samplesBuffer, sampleRate);
  }

  _transcribeOffline(samplesBuffer, sampleRate) {
    // A real request is in flight — the idle timer must not fire mid-request,
    // and _drainActiveRequests() (called from stop()) needs to know this
    // request hasn't settled yet (R8).
    this.clearIdleTimer();
    this.activeRequestCount++;
    const settleRequest = () => {
      this.activeRequestCount = Math.max(0, this.activeRequestCount - 1);
      this.resetIdleTimer();
    };

    const promise = new Promise((resolve, reject) => {
      const startTime = Date.now();
      let result = "";

      const timeout = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error("parakeet-ws transcription timed out"));
      }, TRANSCRIPTION_TIMEOUT_MS);

      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);

      ws.on("open", () => {
        // sherpa-onnx offline WS binary protocol:
        // [int32LE sample_rate][int32LE num_audio_bytes][float32 samples...]
        const message = Buffer.alloc(8 + samplesBuffer.length);
        message.writeInt32LE(sampleRate, 0);
        message.writeInt32LE(samplesBuffer.length, 4);
        samplesBuffer.copy(message, 8);

        debugLogger.debug("parakeet-ws sending audio", {
          samplesBytes: samplesBuffer.length,
          sampleRate,
        });

        ws.send(message, (err) => {
          if (err) {
            debugLogger.error("parakeet-ws send error", { error: err.message });
          }
        });
      });

      ws.on("message", (data) => {
        result += data.toString();
        ws.send("Done");
      });

      ws.on("close", (code) => {
        clearTimeout(timeout);
        const elapsed = Date.now() - startTime;

        debugLogger.debug("parakeet-ws transcription completed", {
          elapsed,
          code,
          resultLength: result.length,
          resultPreview: result.slice(0, 200),
        });

        resolve({ text: parseOfflineMessage(result), elapsed });
      });

      ws.on("error", (error) => {
        clearTimeout(timeout);
        reject(new Error(`parakeet-ws transcription failed: ${error.message}`));
      });
    });

    return promise.finally(settleRequest);
  }

  async stop() {
    this.clearIdleTimer();
    this.stopHealthCheck();
    this._intentionalStop = true;

    if (!this.process) {
      this.ready = false;
      this.modelRuntime = "offline";
      return;
    }

    // R8: never corrupt a request/stream that's actually in flight — wait
    // (bounded) for it to settle before killing the process.
    await this._drainActiveRequests();

    debugLogger.debug("Stopping parakeet-ws server");

    try {
      await gracefulStopProcess(this.process);
    } catch (error) {
      debugLogger.error("Error stopping parakeet-ws server", { error: error.message });
    }

    this.process = null;
    this.ready = false;
    this.port = null;
    this.modelName = null;
    this.modelDir = null;
    this.modelRuntime = "offline";
  }

  getStatus() {
    return {
      available: this.hasAnyWsBinary(),
      running: this.ready && this.process !== null,
      port: this.port,
      modelName: this.modelName,
    };
  }
}

module.exports = ParakeetWsServer;
module.exports.DEFAULT_IDLE_TIMEOUT_MS = DEFAULT_IDLE_TIMEOUT_MS;
module.exports.DRAIN_TIMEOUT_MS = DRAIN_TIMEOUT_MS;
module.exports.STREAMING_DRAIN_TIMEOUT_MS = STREAMING_DRAIN_TIMEOUT_MS;
