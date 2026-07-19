const fs = require("fs");
const { promises: fsPromises } = require("fs");
const path = require("path");
const { app } = require("electron");
const debugLogger = require("./debugLogger");
const {
  downloadFile,
  fetchJson,
  createDownloadSignal,
  checkDiskSpace,
  cleanupStaleDownloads,
  extractArchive,
  findFile,
  findFiles,
} = require("./downloadUtils");

function githubReleaseHeaders() {
  const headers = { Accept: "application/vnd.github+json" };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// Pinned to the same build as the bundled CPU binary (download-llama-server.js)
// and the Vulkan binary (llamaVulkanManager.js) so CUDA, Vulkan and CPU stay on
// one tested llama.cpp. Overridable via LLAMA_CPP_VERSION.
const LLAMA_CPP_TAG = process.env.LLAMA_CPP_VERSION || "b9763";
const GITHUB_RELEASE_URL = `https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${LLAMA_CPP_TAG}`;

// llama.cpp ships the CUDA build as two assets on Windows: the server binary +
// ggml CUDA libs, and a separate cudart archive with the CUDA runtime DLLs
// (cudart64/cublas64/cublasLt64). Both must land in the same bin dir for the
// binary to load. `runtimePattern` is null where the archive is self-contained.
const CUDA_ASSETS = {
  "win32-x64": {
    assetPattern: /^llama-.*-bin-win-cuda-.*-x64\.zip$/,
    runtimePattern: /^cudart-llama-bin-win-cuda-.*-x64\.zip$/,
    binaryName: "llama-server.exe",
    outputName: "llama-server-cuda.exe",
    libPattern: /\.dll$/i,
  },
  "linux-x64": {
    assetPattern: /^llama-.*-bin-ubuntu-cuda-x64\.tar\.gz$/,
    runtimePattern: null,
    binaryName: "llama-server",
    outputName: "llama-server-cuda",
    libPattern: /\.so(\.\d+)*$/,
  },
};

class LlamaCudaManager {
  constructor() {
    this._binDir = null;
    this._downloadSignal = null;
    this._downloading = false;
  }

  get binDir() {
    if (!this._binDir) {
      this._binDir = path.join(app.getPath("userData"), "bin");
    }
    return this._binDir;
  }

  _getConfig() {
    return CUDA_ASSETS[`${process.platform}-${process.arch}`] || null;
  }

  isSupported() {
    return this._getConfig() !== null;
  }

  getBinaryPath() {
    const config = this._getConfig();
    if (!config) return null;
    const p = path.join(this.binDir, config.outputName);
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
    return null;
  }

  isDownloaded() {
    return this.getBinaryPath() !== null;
  }

  getStatus() {
    return {
      supported: this.isSupported(),
      downloaded: this.isDownloaded(),
      downloading: this._downloading,
    };
  }

  async _downloadAndExtractLibs(url, size, extractDir, config, signal, onProgress) {
    const archivePath = path.join(this.binDir, path.basename(new URL(url).pathname));
    await downloadFile(url, archivePath, { signal, expectedSize: size, onProgress });
    try {
      await extractArchive(archivePath, extractDir);
    } finally {
      await fsPromises.unlink(archivePath).catch(() => {});
    }
  }

  async download(onProgress) {
    if (this._downloading) throw new Error("Download already in progress");
    if (!this.isSupported()) throw new Error("CUDA not available for this platform");

    this._downloading = true;
    const { signal, abort } = createDownloadSignal();
    this._downloadSignal = { abort };

    try {
      await fsPromises.mkdir(this.binDir, { recursive: true });
      await cleanupStaleDownloads(this.binDir);

      const release = await fetchJson(GITHUB_RELEASE_URL, { headers: githubReleaseHeaders() });
      if (!release?.assets) throw new Error("Could not fetch llama.cpp release info");

      const config = this._getConfig();
      const asset = release.assets.find((a) => config.assetPattern.test(a.name));
      if (!asset) throw new Error("CUDA binary not found in release");

      const runtimeAsset = config.runtimePattern
        ? release.assets.find((a) => config.runtimePattern.test(a.name))
        : null;

      // Reserve ~2.5x the combined archive size for download + extraction.
      const totalDownloadBytes = (asset.size || 100_000_000) + (runtimeAsset?.size || 0);
      const spaceCheck = await checkDiskSpace(this.binDir, totalDownloadBytes * 2.5);
      if (!spaceCheck.ok) {
        throw new Error(
          `Not enough disk space. Need ~${Math.round((totalDownloadBytes * 2.5) / 1_000_000)}MB, ` +
            `only ${Math.round(spaceCheck.availableBytes / 1_000_000)}MB available.`
        );
      }

      const extractDir = path.join(this.binDir, `temp-cuda-${Date.now()}`);
      await fsPromises.mkdir(extractDir, { recursive: true });

      try {
        // Combined progress across the binary archive and (optional) runtime archive.
        const wrapProgress = (offset) => (downloaded, total) => {
          if (!onProgress) return;
          const combinedDone = offset + downloaded;
          onProgress(combinedDone, totalDownloadBytes, combinedDone / totalDownloadBytes);
        };

        await this._downloadAndExtractLibs(
          asset.browser_download_url,
          asset.size,
          extractDir,
          config,
          signal,
          wrapProgress(0)
        );

        if (runtimeAsset) {
          await this._downloadAndExtractLibs(
            runtimeAsset.browser_download_url,
            runtimeAsset.size,
            extractDir,
            config,
            signal,
            wrapProgress(asset.size || 0)
          );
        }

        const binaryPath = await findFile(extractDir, config.binaryName);
        if (!binaryPath) throw new Error(`${config.binaryName} not found in archive`);

        const outputPath = path.join(this.binDir, config.outputName);
        await fsPromises.copyFile(binaryPath, outputPath);
        if (process.platform !== "win32") await fsPromises.chmod(outputPath, 0o755);

        const libs = await findFiles(extractDir, config.libPattern);
        for (const lib of libs) {
          const dest = path.join(this.binDir, path.basename(lib));
          await fsPromises.copyFile(lib, dest);
          if (process.platform !== "win32") await fsPromises.chmod(dest, 0o755);
        }

        debugLogger.info("CUDA llama-server installed", { path: outputPath });
      } finally {
        await fsPromises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
      }

      return { success: true };
    } catch (error) {
      if (error.isAbort) return { success: false, cancelled: true };
      throw error;
    } finally {
      this._downloading = false;
      this._downloadSignal = null;
    }
  }

  cancelDownload() {
    if (this._downloadSignal) {
      this._downloadSignal.abort();
      this._downloadSignal = null;
      return true;
    }
    return false;
  }

  async deleteBinary() {
    const config = this._getConfig();
    if (!config) return { success: true };

    let deletedCount = 0;
    try {
      const entries = await fsPromises.readdir(this.binDir);
      for (const entry of entries) {
        if (entry === config.outputName || config.libPattern.test(entry)) {
          await fsPromises.unlink(path.join(this.binDir, entry)).catch(() => {});
          deletedCount++;
        }
      }
    } catch {}

    debugLogger.info("CUDA llama-server deleted", { deletedCount });
    return { success: true, deletedCount };
  }
}

module.exports = LlamaCudaManager;
