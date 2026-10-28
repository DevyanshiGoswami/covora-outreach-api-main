// eslint-disable-next-line @typescript-eslint/no-require-imports -- Next loads this CommonJS adapter with require().
const { parse } = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Keep the adapter compatible with Next's CommonJS entry point.
const { globSync: globDirectories, hasMagic } = require("glob");

// Only the directory lookup used by the pinned Next lint plugin is supported.
exports.globSync = function globSync(pattern, options) {
  if (
    typeof pattern !== "string" || !pattern ||
    options?.onlyDirectories !== true ||
    Object.keys(options).length !== 1
  ) {
    throw new TypeError("Review the Next lint glob adapter before changing its API");
  }

  // Configuration is intentionally limited to paths, *, ?, and ** wildcards.
  if (/[{}()[\]\\]/.test(pattern) || pattern.slice(1).includes("!")) {
    throw new TypeError("Unsupported Next rootDir syntax: use paths, *, ?, or ** wildcards");
  }
  // Next processes each array entry separately; a negative entry has no roots.
  if (pattern.startsWith("!")) return [];
  // A final globstar selects descendants, not its base directory.
  const directoryPattern = pattern.replace(/(^|\/)\*\*\/?$/, "$1**/*");
  const paths = globDirectories(`${directoryPattern.replace(/\/$/, "")}/`, {
    follow: true,
    nocase: false,
  });
  if (!hasMagic(pattern, { magicalBraces: true })) return paths.map(() => pattern);
  return paths.map((path) => path.length > parse(path).root.length ? path.replace(/\/$/, "") : path);
};
