// Preserve the existing Copy invitation action while denying camera and other permissions.
export function allowAppPermission(trusted: boolean, permission: string, mediaTypes: string[] = []): boolean {
  return trusted && (permission === "clipboard-sanitized-write" || permission === "media" && mediaTypes.length > 0 && mediaTypes.every((type) => type === "audio"));
}
