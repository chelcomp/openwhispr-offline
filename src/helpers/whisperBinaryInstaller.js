/**
 * Runtime (post-install) recovery download of the whisper-server binary,
 * for when it's missing from resources/bin/ (partial install, AV
 * quarantine, manual deletion). Triggered only by an explicit user click of
 * the "Download" action on the WHISPER_SERVER_BINARY_MISSING toast — never
 * automatically or in the background.
 *
 * This targets the exact same GitHub release assets as
 * scripts/download-whisper-cpp.js (OpenWhispr/whisper.cpp), but is a
 * runtime-safe port rather than a `require()` across the scripts/ -> src/
 * boundary: scripts/ is a dev/build-time tree with no packaging guarantee
 * inside the ASAR. Keep the two copies logically identical — this is the
 * runtime counterpart of scripts/download-whisper-cpp.js and
 * scripts/lib/download-utils.js, the build-time source of truth. Deduplicating
 * them into one shared module is a reasonable follow-up, not required here.
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { app } = require("electron");
const debugLogger = require("./debugLogger");

const WHISPER_CPP_REPO = "OpenWhispr/whisper.cpp";
const REQUEST_TIMEOUT = 30000;
const MAX_REDIRECTS = 5;

// Mirrors scripts/download-whisper-cpp.js's BINARIES map.
const BINARIES = {
  "darwin-arm64": {
    zipName: "whisper-server-darwin-arm64.zip",
    binaryName: "whisper-server-darwin-arm64",
    outputName: "whisper-server-darwin-arm64",
  },
  "darwin-x64": {
    zipName: "whisper-server-darwin-x64.zip",
    binaryName: "whisper-server-darwin-x64",
    outputName: "whisper-server-darwin-x64",
  },
  "win32-x64": {
    zipName: "whisper-server-win32-x64-cpu.zip",
    binaryName: "whisper-server-win32-x64-cpu.exe",
    outputName: "whisper-server-win32-x64.exe",
  },
  "linux-x64": {
    zipName: "whisper-server-linux-x64-cpu.zip",
    binaryName: "whisper-server-linux-x64-cpu",
    outputName: "whisper-server-linux-x64",
  },
};

function fetchJson(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > MAX_REDIRECTS) {
      reject(new Error("Too many redirects"));
      return;
    }

    const headers = {
      "User-Agent": "EktosWhispr-Downloader",
      Accept: "application/vnd.github+json",
    };
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;

    https
      .get(url, { headers, timeout: REQUEST_TIMEOUT }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          const location = res.headers.location;
          if (!location) {
            reject(new Error("Redirect without location header"));
            return;
          }
          const redirectUrl = location.startsWith("/") ? new URL(location, url).href : location;
          fetchJson(redirectUrl, redirectCount + 1)
            .then(resolve)
            .catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON: ${e.message}`));
          }
        });
        res.on("error", reject);
      })
      .on("error", reject)
      .on("timeout", () => reject(new Error("Request timeout")));
  });
}

const GITHUB_TOKEN_HOSTS = new Set(["github.com", "api.github.com"]);

function isGithubTokenHost(urlString) {
  try {
    const hostname = new URL(urlString).hostname.toLowerCase();
    return GITHUB_TOKEN_HOSTS.has(hostname) || hostname.endsWith(".github.com");
  } catch {
    return false;
  }
}

function formatRelease(release) {
  return {
    tag: release.tag_name,
    url: release.html_url,
    assets: (release.assets || []).map((asset) => ({
      name: asset.name,
      url: asset.browser_download_url,
    })),
  };
}

async function fetchLatestRelease(repo) {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const release = await fetchJson(url);
  return formatRelease(release);
}

function downloadFile(url, dest, onProgress, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let activeRequest = null;

    const cleanup = () => {
      if (activeRequest) {
        activeRequest.destroy();
        activeRequest = null;
      }
      file.close();
    };

    const request = (currentUrl, redirects) => {
      if (redirects > MAX_REDIRECTS) {
        cleanup();
        reject(new Error("Too many redirects"));
        return;
      }

      const reqHeaders = { "User-Agent": "EktosWhispr-Downloader" };
      const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      if (ghToken && isGithubTokenHost(currentUrl)) {
        reqHeaders.Authorization = `Bearer ${ghToken}`;
      }

      activeRequest = https.get(currentUrl, { headers: reqHeaders }, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          const location = response.headers.location;
          if (!location) {
            cleanup();
            reject(new Error("Redirect without location header"));
            return;
          }
          const redirectUrl = location.startsWith("/")
            ? new URL(location, currentUrl).href
            : location;
          request(redirectUrl, redirects + 1);
          return;
        }

        if (response.statusCode !== 200) {
          cleanup();
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        const total = parseInt(response.headers["content-length"], 10);
        let downloaded = 0;

        response.on("data", (chunk) => {
          downloaded += chunk.length;
          if (onProgress && total) {
            onProgress(Math.round((downloaded / total) * 100));
          }
        });

        response.on("error", (err) => {
          cleanup();
          reject(err);
        });

        response.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });

        file.on("error", (err) => {
          cleanup();
          reject(err);
        });
      });

      activeRequest.on("error", (err) => {
        cleanup();
        reject(err);
      });

      activeRequest.setTimeout(REQUEST_TIMEOUT, () => {
        cleanup();
        reject(new Error("Connection timed out"));
      });
    };

    request(url, redirectCount);
  });
}

function findBinaryInDir(dir, binaryName, maxDepth = 5, currentDepth = 0) {
  if (currentDepth >= maxDepth) return null;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findBinaryInDir(fullPath, binaryName, maxDepth, currentDepth + 1);
      if (found) return found;
    } else if (entry.name === binaryName) {
      return fullPath;
    }
  }
  return null;
}

async function extractZip(zipPath, destDir) {
  if (process.platform === "win32") {
    const unzipper = require("unzipper");
    await fs
      .createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: destDir }))
      .promise();
  } else {
    const { execSync } = require("child_process");
    execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: "ignore" });
  }
}

function setExecutable(filePath) {
  if (process.platform !== "win32") {
    fs.chmodSync(filePath, 0o755);
  }
}

/**
 * Downloads and installs the whisper-server binary for the current
 * platform/arch to `userData/bin/`, the location `getServerBinaryPath()`
 * already checks. Single attempt — no internal retry loop; the caller (the
 * `download-whisper-server-binary` IPC handler) does not auto-retry either.
 *
 * @param {(percent: number) => void} [onProgress]
 * @param {object} [deps] - injectable for tests
 * @returns {Promise<{success: true, binaryPath: string}>}
 */
async function downloadServerBinary(onProgress, deps = {}) {
  const {
    fetchLatestReleaseFn = fetchLatestRelease,
    downloadFileFn = downloadFile,
    extractZipFn = extractZip,
    findBinaryInDirFn = findBinaryInDir,
    setExecutableFn = setExecutable,
  } = deps;

  const platformArch = `${process.platform}-${process.arch}`;
  const config = BINARIES[platformArch];
  if (!config) {
    throw new Error(`Unsupported platform/arch for whisper-server download: ${platformArch}`);
  }

  const release = await fetchLatestReleaseFn(WHISPER_CPP_REPO);
  if (!release) {
    throw new Error(`Could not fetch latest release from ${WHISPER_CPP_REPO}`);
  }

  const asset = release.assets.find((a) => a.name === config.zipName);
  if (!asset) {
    throw new Error(`Asset ${config.zipName} not found in latest ${WHISPER_CPP_REPO} release`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ektoswhispr-whisper-install-"));
  const zipPath = path.join(tempDir, config.zipName);
  const extractDir = path.join(tempDir, "extracted");

  try {
    debugLogger.info("Downloading whisper-server binary at runtime", {
      platformArch,
      url: asset.url,
    });

    await downloadFileFn(asset.url, zipPath, onProgress);

    fs.mkdirSync(extractDir, { recursive: true });
    await extractZipFn(zipPath, extractDir);

    const binaryPath = findBinaryInDirFn(extractDir, config.binaryName);
    if (!binaryPath) {
      throw new Error(`Binary "${config.binaryName}" not found in downloaded archive`);
    }

    const destDir = path.join(app.getPath("userData"), "bin");
    fs.mkdirSync(destDir, { recursive: true });
    const destPath = path.join(destDir, config.outputName);

    fs.copyFileSync(binaryPath, destPath);
    setExecutableFn(destPath);

    debugLogger.info("whisper-server binary installed at runtime", { destPath });

    return { success: true, binaryPath: destPath };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

module.exports = {
  BINARIES,
  downloadServerBinary,
};
