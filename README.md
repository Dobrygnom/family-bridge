# Family Bridge

Family Bridge connects two locally running Codex agents for an autonomous, bounded conversation. Personal psychological archives stay on each owner's computer; only agent-authored messages and shared reports cross the transport.

The repository contains a verified two-agent Codex CLI runner, reliable claim/ack queue semantics, an Electron + React desktop UI, a Supabase Realtime transport, client-side payload encryption, and installation/sync instructions.

## Release 1.0.0

[Release notes](docs/RELEASE_1.0.0.md): live continuation messages without tab switching, explicit partner-version checks, and native Electron networking for dictation. Existing context, selected topics, reports, and text drafts are preserved. CI builds a draft release; installers, checksums, and updater metadata are verified before it is published.

## Verified local demo

```powershell
npm install
npm test
npm run demo
```

`npm run demo` creates two new Codex CLI sessions, alternates their messages, stops after agreement or the turn limit, and writes a JSON report under `.family-bridge/demo-output/`.

Use `npm run demo:mock` to test the protocol without consuming Codex usage.

## Desktop application

```powershell
npm run build
npm run package
```

The installer is written to `release/`. On first launch, the app guides the owner through selecting a Codex chat, shows the export/analysis stages, and then opens a compact topic registry grouped by intended counterpart. Codex prepares topic drafts with two distinct fields: who the topic is about and who it may be discussed with. Rows stay collapsed by default; details open only when needed, cross-person topics are raised for review, and safe direct topics can be approved in bulk. Pairing appears only after this review is completed. During pairing, the owner selects which local-context person the other computer represents; only approved topics routed to that person enter the pair. Each pending topic is then discussed in its own parallel agent conversation. Raw context remains local. The interface supports Russian, English, Czech, and French.

## Production transport

The bundled desktop build is connected to the deployed Family Bridge Supabase project. Pair the two installations with a one-time invitation containing the client-side encryption secret. For self-hosting, create a Supabase project, apply [`supabase/migrations/001_family_bridge.sql`](supabase/migrations/001_family_bridge.sql), enable anonymous sign-ins, and replace the public endpoint configuration.

Never put a Supabase service-role key in the desktop application.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — complete architecture and security model.
- [`INSTALL_FOR_CODEX.md`](INSTALL_FOR_CODEX.md) — one-file setup instruction for Codex Desktop on the second computer.
- [`docs/DESKTOP_SYNC_PROMPT.md`](docs/DESKTOP_SYNC_PROMPT.md) — legacy migration reference for installations created before in-app context selection.

## Voice dictation (0.3.29)

Answers to your agent and new topics have a **Dictate** button. Record up to two minutes, stop, review the inserted draft, and send explicitly. Recording/transcription can be cancelled; failed uploads can be retried without re-recording while the field remains open. Existing typed text is appended to, never replaced. Owner-answer drafts are saved in this app's local profile until submitted.

Audio is sent directly to OpenAI using the existing Codex ChatGPT login, not to the partner or a third-party relay. The app keeps recordings only in memory, and does not log or copy credentials. This uses the **internal, undocumented ChatGPT dictation endpoint**; availability and compatibility are not guaranteed. No API key or local transcription model is used. When the service is unavailable, typing remains available.

On macOS, allow microphone access when prompted. Denied permissions can be changed in System Settings → Privacy & Security → Microphone. File-based Codex credentials are supported on Windows/macOS; the direct Codex Auth Keychain entry is also supported on macOS when configured. Other credential-store backends may require additional integration; the app never changes credential-storage settings automatically.

## Safety

This is an experimental mediation aid, not a licensed therapist or emergency service. It must pause autonomous dialogue when it detects immediate danger, abuse, self-harm risk, or a topic prohibited by either owner.
