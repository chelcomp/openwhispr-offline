const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const debugLogger = require("./debugLogger");
const { killProcess } = require("../utils/process");
const { isPortAvailable } = require("../utils/serverUtils");
const { getSafeTempDir } = require("./safeTempDir");
const sidecarPidFile = require("./sidecarPidFile");
const { getBackendChain, getAllBackends } = require("./llamaBackends");

// Range kept clear of cliBridge (8200-8219) to avoid port-bind collisions.
const PORT_RANGE_START = 8221;
const PORT_RANGE_END = 8240;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const HEALTH_CHECK_TIMEOUT_MS = 2000;
const STARTUP_POLL_INTERVAL_MS = 500;
const HEALTH_CHECK_FAILURE_THRESHOLD = 3;
// Default/fallback idle timeout, matching the pre-existing hardcoded value —
// now overridable at runtime via setIdleTimeoutMs(ms), fed by the
// `llmIdleTimeoutMs` setting (see docs/specs/on-demand-model-lifecycle.md).
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
// Matches the fallback literal already used by both modelManagerBridge.js call
// sites (runInference/prewarmServer) so the same number appears in one more
// place, not a new arbitrary value.
const DEFAULT_CONTEXT_SIZE = 4096;
// The value modelManagerBridge.js targets on a fresh (non-retry) server start
// for a model. _doStart itself doesn't know about this — it just launches
// whatever --ctx-size it's given, clamped only against MAX_CONTEXT_SIZE below.
const DEFAULT_CONTEXT_CAP = 2048;
// The real outer ceiling _doStart enforces, reachable only via
// modelManagerBridge.js's overflow-doubling retry logic.
const MAX_CONTEXT_SIZE = 65536;

// llama.cpp's OpenAI-compatible error shape when the request/context exceeds
// the server's configured --ctx-size. Matched defensively by keyword, not an
// exact string, since wording can vary across llama.cpp builds/tags.
function isContextOverflowMessage(message) {
  if (!message || typeof message !== "string") return false;
  const lower = message.toLowerCase();
  if (!lower.includes("context")) return false;
  return (
    lower.includes("exceed") ||
    lower.includes("too long") ||
    lower.includes("too large") ||
    lower.includes("increase")
  );
}

class ContextOverflowError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContextOverflowError";
    this.isContextOverflow = true;
  }
}

// Cache of { kvCacheQuant, fit } per binary path, mirroring llamaBackends.js's
// vulkanDeviceCache pattern — runs `--help` at most once per binary per app run.
const binaryCapabilitiesCache = new Map();

function probeBinaryCapabilities(binaryPath) {
  if (!binaryPath) return { kvCacheQuant: false, fit: false };
  if (binaryCapabilitiesCache.has(binaryPath)) return binaryCapabilitiesCache.get(binaryPath);

  let capabilities = { kvCacheQuant: false, fit: false };
  try {
    const output = execFileSync(binaryPath, ["--help"], {
      timeout: 5000,
      windowsHide: true,
    }).toString();
    const kvCacheQuant =
      output.includes("--cache-type-k") &&
      output.includes("--cache-type-v") &&
      output.includes("--flash-attn");
    const fit = output.includes("-fit") || output.includes("--fit");
    capabilities = { kvCacheQuant, fit };
  } catch {
    capabilities = { kvCacheQuant: false, fit: false };
  }

  binaryCapabilitiesCache.set(binaryPath, capabilities);
  return capabilities;
}

class LlamaServerManager {
  constructor() {
    this.process = null;
    this.port = null;
    this.ready = false;
    this.modelPath = null;
    this.startupPromise = null;
    this.healthCheckInterval = null;
    this.healthCheckFailures = 0;
    this.activeBackend = null;
    this.idleTimer = null;
    this.idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
    // Set right before any stop() this manager itself initiates (idle timeout,
    // model switch, shutdown) so the process.on("close", ...) handler can log
    // an unexpected exit distinctly (R7) without ever scheduling a respawn.
    this._intentionalStop = false;
  }

  // Called whenever the `llmIdleTimeoutMs` setting changes (and once at
  // startup-sync time); defaults to DEFAULT_IDLE_TIMEOUT_MS until then. Takes
  // effect on the next resetIdleTimer() call — an in-flight timer keeps
  // running on its previous duration rather than being retroactively rescheduled.
  setIdleTimeoutMs(ms) {
    this.idleTimeoutMs = Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_IDLE_TIMEOUT_MS;
  }

  isAvailable() {
    return getAllBackends().some((backend) => backend.isAvailable());
  }

  async findAvailablePort() {
    for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
      if (await isPortAvailable(port)) return port;
    }
    throw new Error(`No available ports in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
  }

  async start(modelPath, options = {}) {
    if (this.startupPromise) return this.startupPromise;

    if (this.ready && this.modelPath === modelPath) return;

    if (this.process) {
      await this.stop();
    }

    this.startupPromise = this._doStart(modelPath, options);
    try {
      await this.startupPromise;
    } finally {
      this.startupPromise = null;
    }
  }

  async _doStart(modelPath, options = {}) {
    if (!this.isAvailable()) throw new Error("llama-server binary not found");
    if (!fs.existsSync(modelPath)) throw new Error(`Model file not found: ${modelPath}`);

    this.port = await this.findAvailablePort();
    this.modelPath = modelPath;

    const resolvedContextSize =
      Number.isFinite(options.contextSize) && options.contextSize > 0
        ? options.contextSize
        : DEFAULT_CONTEXT_SIZE;
    const ctxSize = Math.min(resolvedContextSize, MAX_CONTEXT_SIZE);

    const baseArgs = [
      "--model",
      modelPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(this.port),
      "--threads",
      String(options.threads || 4),
      "--ctx-size",
      String(ctxSize),
      "--jinja",
    ];

    const gpuMode = process.env.LLAMA_GPU_MODE || "auto";
    // Each backend (CUDA / Vulkan / CPU / Metal) owns its own binary, args and
    // env — see llamaBackends.js. We walk the chain and start the first one that
    // has a binary and boots successfully, falling back to the next on failure.
    const chain = getBackendChain(gpuMode).filter((backend) => backend.isAvailable());
    if (chain.length === 0) throw new Error("llama-server binary not found");

    let lastError = null;
    let started = false;

    for (const backend of chain) {
      try {
        await this._startBackend(backend, baseArgs, gpuMode);
        this.activeBackend = backend.name;
        started = true;
        break;
      } catch (err) {
        lastError = err;
        debugLogger.warn("llama-server backend failed, trying next fallback", {
          backend: backend.name,
          gpuMode,
          error: err.message,
        });
        await this._killCurrentProcess();
        this.port = await this.findAvailablePort();

        // If the failed attempt included the capability-gated flags
        // (KV-cache quantization/flash-attn/--fit), retry this same backend
        // exactly once with those flags stripped before moving on to the
        // next backend in the chain.
        const capabilities = probeBinaryCapabilities(backend.getBinaryPath());
        if (capabilities.kvCacheQuant || capabilities.fit) {
          try {
            await this._startBackend(backend, baseArgs, gpuMode, { stripCapabilityFlags: true });
            this.activeBackend = backend.name;
            started = true;
            break;
          } catch (err2) {
            lastError = err2;
            debugLogger.warn("llama-server backend failed again without capability flags", {
              backend: backend.name,
              gpuMode,
              error: err2.message,
            });
            await this._killCurrentProcess();
            this.port = await this.findAvailablePort();
          }
        }
      }
    }

    if (!started) throw lastError || new Error("llama-server failed to start");

    this.startHealthCheck();
    this.resetIdleTimer();
    debugLogger.info("llama-server started successfully", {
      port: this.port,
      model: path.basename(modelPath),
      backend: this.activeBackend,
    });
  }

  async _startBackend(backend, baseArgs, gpuMode, { stripCapabilityFlags = false } = {}) {
    const binaryPath = backend.getBinaryPath();
    if (!binaryPath) throw new Error(`No ${backend.name} llama-server binary available`);

    let args = backend.buildArgs(baseArgs, gpuMode);
    let kvCacheQuantized = false;
    let fitEnabled = false;

    if (!stripCapabilityFlags) {
      const capabilities = probeBinaryCapabilities(binaryPath);
      if (capabilities.kvCacheQuant) {
        args = [...args, "--cache-type-k", "q8_0", "--cache-type-v", "q8_0", "--flash-attn", "on"];
        kvCacheQuantized = true;
      }
      if (capabilities.fit) {
        // Keep --fit adjacent to --n-gpu-layers in the argv/log for readability.
        const gpuLayersIdx = args.indexOf("--n-gpu-layers");
        if (gpuLayersIdx !== -1) {
          args = [
            ...args.slice(0, gpuLayersIdx + 2),
            "--fit",
            "on",
            ...args.slice(gpuLayersIdx + 2),
          ];
        } else {
          args = [...args, "--fit", "on"];
        }
        fitEnabled = true;
      }
    }

    const env = backend.buildEnv(binaryPath);

    // Print the exact launch parameters so the chosen backend and every flag are
    // visible in the logs.
    debugLogger.info("llama-server launch parameters", {
      backend: backend.name,
      gpuMode,
      gpuAccelerated: backend.gpuAccelerated,
      binary: binaryPath,
      kvCacheQuantized,
      fitEnabled,
      args,
    });

    await this._startWithBinary(binaryPath, args, env, backend.startupTimeoutMs);
  }

  _startWithBinary(binaryPath, args, env, timeoutMs) {
    return new Promise((resolve, reject) => {
      debugLogger.debug("Spawning llama-server", { binary: binaryPath, port: this.port, args });

      this._intentionalStop = false;
      this.process = spawn(binaryPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        cwd: getSafeTempDir(),
        env,
        detached: process.platform !== "win32",
      });
      sidecarPidFile.write("llama", this.process.pid);

      let stderrBuffer = "";
      let exitCode = null;
      let exitSignal = null;
      let settled = false;

      const settle = (fn) => {
        if (settled) return;
        settled = true;
        fn();
      };

      this.process.stdout.on("data", (data) => {
        debugLogger.debug("llama-server stdout", { data: data.toString().trim() });
      });

      this.process.stderr.on("data", (data) => {
        const chunk = data.toString();
        if (stderrBuffer.length < 65536) stderrBuffer += chunk;
        debugLogger.debug("llama-server stderr", { data: chunk.trim() });
      });

      this.process.on("error", (error) => {
        debugLogger.error("llama-server process error", { error: error.message });
        this.ready = false;
        settle(() => reject(new Error(`Failed to spawn llama-server: ${error.message}`)));
      });

      this.process.on("close", (code, signal) => {
        exitCode = code;
        exitSignal = signal;
        if (this._intentionalStop) {
          debugLogger.debug("llama-server process exited", { code, signal });
        } else {
          // R7 — no proactive respawn, ever: just log distinctly and let the
          // next on-demand start() (warm-up trigger or real inference call)
          // cold-start it normally, same as any other "no process" state.
          debugLogger.error("llama-server exited unexpectedly (crash, not an intentional stop)", {
            code,
            signal,
          });
        }
        this.ready = false;
        this.process = null;
        this.stopHealthCheck();
        sidecarPidFile.clear("llama");
      });

      const getProcessInfo = () => ({ stderr: stderrBuffer, exitCode, exitSignal });

      const startTime = Date.now();
      let pollCount = 0;

      const poll = async () => {
        if (settled) return;

        if (!this.process || this.process.killed) {
          const info = getProcessInfo();
          const signal = info.exitSignal;
          const diagParts = [];
          if (signal) diagParts.push(`signal: ${signal}`);
          else if (info.exitCode !== null && info.exitCode !== undefined)
            diagParts.push(`exit code: ${info.exitCode}`);
          const oomHint =
            signal === "SIGKILL"
              ? " — the process was killed by the OS, likely due to insufficient memory. Try a smaller/more quantized model, or reduce the context size."
              : "";
          const stderr = info.stderr ? info.stderr.trim().slice(-800) : "";
          const diagStr = diagParts.length ? ` (${diagParts.join(", ")})` : "";
          settle(() =>
            reject(
              new Error(
                `llama-server process died during startup${diagStr}${oomHint}${stderr ? `\nProcess output: ${stderr}` : ""}`
              )
            )
          );
          return;
        }

        pollCount++;
        if (await this.checkHealth()) {
          this.ready = true;
          debugLogger.debug("llama-server ready", {
            startupTimeMs: Date.now() - startTime,
            pollCount,
          });
          settle(() => resolve());
          return;
        }

        if (Date.now() - startTime >= timeoutMs) {
          settle(() => reject(new Error(`llama-server failed to start within ${timeoutMs}ms`)));
          return;
        }

        setTimeout(poll, STARTUP_POLL_INTERVAL_MS);
      };

      poll();
    });
  }

  async _killCurrentProcess() {
    if (!this.process) return;

    this._intentionalStop = true;
    this.stopHealthCheck();

    try {
      killProcess(this.process, "SIGTERM");
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) killProcess(this.process, "SIGKILL");
          resolve();
        }, 5000);

        if (this.process) {
          this.process.once("close", () => {
            clearTimeout(timeout);
            resolve();
          });
        } else {
          clearTimeout(timeout);
          resolve();
        }
      });
    } catch (error) {
      debugLogger.error("Error killing llama-server process", { error: error.message });
    }

    this.process = null;
    this.ready = false;
  }

  checkHealth() {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/health",
          method: "GET",
          timeout: HEALTH_CHECK_TIMEOUT_MS,
        },
        (res) => {
          resolve(res.statusCode === 200);
          res.resume();
        }
      );

      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });
  }

  startHealthCheck() {
    this.stopHealthCheck();
    this.healthCheckFailures = 0;
    this.healthCheckInterval = setInterval(async () => {
      try {
        if (!this.process) {
          this.stopHealthCheck();
          return;
        }
        if (await this.checkHealth()) {
          this.healthCheckFailures = 0;
        } else {
          this.healthCheckFailures++;
          if (this.healthCheckFailures >= HEALTH_CHECK_FAILURE_THRESHOLD) {
            debugLogger.warn("llama-server health check failed", {
              consecutiveFailures: this.healthCheckFailures,
            });
            this.ready = false;
          }
        }
      } catch (err) {
        debugLogger.error("Health check error", { error: err.message });
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  resetIdleTimer() {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      debugLogger.info("llama-server idle timeout reached, stopping to free VRAM", {
        timeoutMs: this.idleTimeoutMs,
        model: this.modelPath ? path.basename(this.modelPath) : null,
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

  async inference(messages, options = {}) {
    if (!this.ready || !this.process) {
      throw new Error("llama-server is not running");
    }

    this.clearIdleTimer();

    const requestBody = {
      messages,
      // Coerce with Number(): llama-server's JSON schema requires these as numbers
      // and rejects the whole request with a 400 if any arrives as a string (e.g.
      // a stale/corrupted settingsStore value surviving a hot-reload).
      temperature: Number(options.temperature ?? 0.7),
      max_tokens: Number(options.max_tokens ?? 512),
      stream: false,
    };

    // llama.cpp's OpenAI-compatible endpoint accepts these sampling extensions.
    // Only send the ones the caller provided so llama.cpp defaults apply otherwise.
    if (options.topP != null) requestBody.top_p = Number(options.topP);
    if (options.topK != null) requestBody.top_k = Number(options.topK);
    if (options.minP != null) requestBody.min_p = Number(options.minP);
    if (options.repeatPenalty != null) requestBody.repeat_penalty = Number(options.repeatPenalty);

    // Without this, Qwen chat templates leave `message.content` empty and
    // route output into `reasoning_content`. Non-Qwen templates ignore it.
    if (options.disableThinking !== false) {
      requestBody.chat_template_kwargs = { enable_thinking: false };
    }

    const body = JSON.stringify(requestBody);

    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: 300000,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            debugLogger.debug("llama-server inference completed", {
              statusCode: res.statusCode,
              elapsed: Date.now() - startTime,
            });

            if (res.statusCode !== 200) {
              let overflowMessage = null;
              try {
                const parsed = JSON.parse(data);
                const message = parsed?.error?.message;
                if (isContextOverflowMessage(message)) overflowMessage = message;
              } catch {
                // Non-JSON or unexpected shape — treat as a non-overflow error below.
              }

              if (overflowMessage) {
                reject(new ContextOverflowError(overflowMessage));
              } else {
                reject(new Error(`llama-server returned status ${res.statusCode}: ${data}`));
              }
              return;
            }

            try {
              const response = JSON.parse(data);
              const message = response.choices?.[0]?.message;
              const text = message?.content || message?.reasoning_content || "";
              resolve(text.trim());
            } catch (e) {
              reject(new Error(`Failed to parse llama-server response: ${e.message}`));
            }
          });
        }
      );

      req.on("error", (error) => {
        reject(new Error(`llama-server request failed: ${error.message}`));
      });
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("llama-server request timed out"));
      });

      req.write(body);
      req.end();
    }).finally(() => this.resetIdleTimer());
  }

  async stop() {
    this.clearIdleTimer();
    this.stopHealthCheck();
    this._intentionalStop = true;

    if (!this.process) {
      this.ready = false;
      return;
    }

    debugLogger.debug("Stopping llama-server");

    try {
      killProcess(this.process, "SIGTERM");

      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) {
            killProcess(this.process, "SIGKILL");
          }
          resolve();
        }, 5000);

        if (this.process) {
          this.process.once("close", () => {
            clearTimeout(timeout);
            resolve();
          });
        } else {
          clearTimeout(timeout);
          resolve();
        }
      });
    } catch (error) {
      debugLogger.error("Error stopping llama-server", { error: error.message });
    }

    this.process = null;
    this.ready = false;
    this.port = null;
    this.modelPath = null;
    this.activeBackend = null;
  }

  getStatus() {
    return {
      available: this.isAvailable(),
      running: this.ready && this.process !== null,
      port: this.port,
      modelPath: this.modelPath,
      modelName: this.modelPath ? path.basename(this.modelPath, ".gguf") : null,
      backend: this.activeBackend,
      gpuAccelerated:
        this.activeBackend === "cuda" ||
        this.activeBackend === "vulkan" ||
        this.activeBackend === "metal",
    };
  }

  resetGpuDetection() {
    this.activeBackend = null;
  }
}

module.exports = LlamaServerManager;
module.exports.DEFAULT_IDLE_TIMEOUT_MS = DEFAULT_IDLE_TIMEOUT_MS;
module.exports.DEFAULT_CONTEXT_SIZE = DEFAULT_CONTEXT_SIZE;
module.exports.DEFAULT_CONTEXT_CAP = DEFAULT_CONTEXT_CAP;
module.exports.MAX_CONTEXT_SIZE = MAX_CONTEXT_SIZE;
module.exports.ContextOverflowError = ContextOverflowError;
module.exports.isContextOverflowMessage = isContextOverflowMessage;
module.exports.probeBinaryCapabilities = probeBinaryCapabilities;
