export function windowsProcessImage(tasklist: string) {
  const first = tasklist.trim().split(/\r?\n/, 1)[0] ?? "";
  const quoted = first.match(/^"([^"]+)"/i)?.[1];
  return (quoted ?? first.split(/[ ,]/, 1)[0] ?? "").trim();
}

export function isWindowsInstallerParent(tasklist: string) {
  const image = windowsProcessImage(tasklist);
  return /(?:family[ -]bridge.*(?:setup|\d+.*(?:x64|arm64))|installer|uninstaller)\.exe$/i.test(image);
}
