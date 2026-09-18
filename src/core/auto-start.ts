export function loginItemSettings(platform: NodeJS.Platform, enabled: boolean) {
  return platform === "win32"
    ? { openAtLogin: enabled, args: ["--hidden"] }
    : { openAtLogin: enabled };
}

export function shouldLaunchHidden(platform: NodeJS.Platform, enabled: boolean, argv: readonly string[], wasOpenedAtLogin = false) {
  if (!enabled) return false;
  return platform === "win32" ? argv.includes("--hidden") : platform === "darwin" && wasOpenedAtLogin;
}
