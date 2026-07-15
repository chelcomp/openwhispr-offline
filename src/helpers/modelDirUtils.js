const { app } = require("electron");
const os = require("os");
const path = require("path");

function getCacheRoot() {
  const homeDir = app?.getPath?.("home") || os.homedir();
  return path.join(homeDir, ".cache", "ektoswhispr");
}

function getModelsDirForService(service) {
  return path.join(getCacheRoot(), `${service}-models`);
}

module.exports = { getCacheRoot, getModelsDirForService };
