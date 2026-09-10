# Production diagnostics: Windows Inspector failure, 2026-09-10

For support-enabled builds, use the [remote support operator interface](remote-support.md)
first. It reads the running application without connecting Electron Inspector.

Do not close a debugger WebSocket while a Runtime.evaluate request is still awaiting its response. In Electron 38.8.6 on Windows this can crash the debugged process in `node::inspector::TcpHolder::WriteRaw`, with access violation `0xC0000005` (read at `0x148`, module offset `0x8383c5`).

The 12:39 local crash on 2026-09-10 followed the diagnostic helper sending a request to schedule `inspector.close()` and immediately closing its WebSocket without awaiting the request's response. The same sequence reproduced a native crash in an isolated Electron process. Awaiting the matching response before closing the socket survived repeated isolated checks.

Always await responses for every outstanding inspector request before closing the connection. Prefer an ordinary application restart without the inspector after diagnostics. Do not test the unsafe sequence on a user's app. Crash dumps can contain private conversations and credentials; analyze locally, never upload them by default. Download public matching symbols instead.

## Launch/profile verification in this environment

Processes launched directly from command tools (including an in-process `Shell.Application.ShellExecute`) can see a stale filesystem snapshot at the SAME profile path. In the observed incident those processes saw 40 reports and an old peer version, while the normal Windows-launched app had 45 reports and newer state. An absolute path alone does not prove the profile view is current.

Launching the installed executable through `explorer.exe` restored the native profile view in this environment. Verify preservation against metadata captured from the previously running native app: report hashes, active transcript prefixes, pairing identity, topic approvals and draft hashes. Never overwrite the native profile with a tooling snapshot to make counts match. Do not infer participant names from the historical internal owner IDs.

This incident does not establish the cause of any Mac authorization failure or any earlier crash without a matching dump.
