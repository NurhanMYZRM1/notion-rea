// Expo's default config (monorepo-aware) plus one native-only alias, see lib/shims/lib0-webcrypto.js.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
// The monorepo root is watched; local Worker state (SQLite under .wrangler) changes on every API call.
config.resolver.blockList = [...[config.resolver.blockList ?? []].flat(), /[/\\]\.wrangler[/\\]/];
const webcryptoShim = path.resolve(__dirname, "lib/shims/lib0-webcrypto.js");
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "lib0/webcrypto" && (platform === "ios" || platform === "android")) return { type: "sourceFile", filePath: webcryptoShim };
  return (upstream ?? context.resolveRequest)(context, moduleName, platform);
};
module.exports = config;
