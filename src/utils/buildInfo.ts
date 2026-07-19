// Pure, Electron/framework-free build-info helpers.
// GIT_COMMIT_HASH resolves from a Vite `define` (__GIT_COMMIT_HASH__) baked in at
// build time (see src/vite.config.mjs). When imported outside a Vite build
// (e.g. plain `node --test`), __GIT_COMMIT_HASH__ is undefined, so we fall
// back to the literal "dev" rather than throwing a ReferenceError.
export const GIT_COMMIT_HASH: string =
  typeof __GIT_COMMIT_HASH__ !== "undefined" ? __GIT_COMMIT_HASH__ : "dev";

const isPlaceholderHash = (gitHash: string): boolean => gitHash === "unknown" || gitHash === "dev";

export function formatVersionBadgeLabel(
  version: string | null | undefined,
  gitHash: string
): string {
  const hasVersion = Boolean(version);
  const hasRealHash = Boolean(gitHash) && !isPlaceholderHash(gitHash);

  if (hasVersion && hasRealHash) {
    return `v${version} (${gitHash})`;
  }
  if (!hasVersion && hasRealHash) {
    return `(${gitHash})`;
  }
  if (hasVersion && !hasRealHash) {
    return `v${version}`;
  }
  return "";
}
