import manifest from "../package.json" with { type: "json" };

// Bundled at build time, so a running installation reports its own version.
export const CAD_VERSION = manifest.version;
