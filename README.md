# Family Bridge

Family Bridge connects two locally running Codex agents for an autonomous, bounded conversation. Personal psychological archives stay on each owner's computer; only agent-authored messages and shared reports cross the transport.

The repository contains a verified two-agent Codex CLI runner, reliable claim/ack queue semantics, an Electron + React desktop UI, a Supabase Realtime transport, client-side payload encryption, and installation/sync instructions.

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

The installer is written to `release/`. The installed app starts in the background, detects Codex CLI authentication, maintains a topic queue, runs conversations, and stores reports locally. The interface supports Russian, English, Czech, and French.

## Production transport

The bundled desktop build is connected to the deployed Family Bridge Supabase project. Pair the two installations with a one-time invitation containing the client-side encryption secret. For self-hosting, create a Supabase project, apply [`supabase/migrations/001_family_bridge.sql`](supabase/migrations/001_family_bridge.sql), enable anonymous sign-ins, and replace the public endpoint configuration.

Never put a Supabase service-role key in the desktop application.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — complete architecture and security model.
- [`INSTALL_FOR_CODEX.md`](INSTALL_FOR_CODEX.md) — one-file setup instruction for Codex Desktop on the second computer.
- [`docs/DESKTOP_SYNC_PROMPT.md`](docs/DESKTOP_SYNC_PROMPT.md) — persistent memory-sync task instruction.

## Safety

This is an experimental mediation aid, not a licensed therapist or emergency service. It must pause autonomous dialogue when it detects immediate danger, abuse, self-harm risk, or a topic prohibited by either owner.
