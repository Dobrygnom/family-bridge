import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SupabaseTransport, type PairingInvite, type AuthStorage } from "../src/core/supabase-transport.js";
import { generateSharedSecret } from "../src/core/encryption.js";
import { durableAuthStorage } from "./auth-storage.js";
import { replaceStateFile } from "./store.js";
import type { SupportContext } from "./remote-support.js";

export interface SupportOffer { logicalPairId: string; creatorId: string; invite: PairingInvite }
interface SavedChannel extends SupportOffer { creator: boolean }
const uuid = (value: unknown) => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
function validOffer(value: unknown): value is SupportOffer {
  const r = value as SupportOffer | null;
  return Boolean(r && uuid(r.logicalPairId) && uuid(r.creatorId) && r.invite?.version === 1 && uuid(r.invite.pairId)
    && r.invite.pairId !== r.logicalPairId && /^[A-Za-z0-9_-]{43}$/.test(r.invite.encryptionSecret)
    && /^[A-Za-z0-9_-]{43}$/.test(r.invite.inviteSecret));
}

/** Separate auth storage and encryption key, provisioned only through an
 * authenticated existing pair. A dialogue-token failure cannot strand support. */
export class SupportChannel {
  private logicalPairId?: string;
  private directory?: string;
  private saved?: SavedChannel;
  private transport?: SupabaseTransport;
  private working?: Promise<unknown>;
  constructor(private readonly root: string,
    private readonly makeTransport: (secret: string, storage: AuthStorage, preserve: boolean) => SupabaseTransport,
    private readonly binding: () => Promise<{ pairId: string; owner: "dima" | "katya" } | undefined>) {}

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = (this.working ?? Promise.resolve()).catch(() => undefined).then(run);
    this.working = next;
    return next;
  }
  private async load() {
    const binding = await this.binding();
    if (binding?.pairId !== this.logicalPairId) {
      this.transport?.dispose(); this.transport = undefined; this.saved = undefined;
      this.logicalPairId = binding?.pairId;
      this.directory = binding ? path.join(this.root, createHash("sha256").update(binding.pairId).digest("hex").slice(0,32)) : undefined;
      if (this.directory) {
        try {
          const saved = JSON.parse(await readFile(path.join(this.directory, "channel.json"), "utf8")) as SavedChannel;
          if (!validOffer(saved) || saved.logicalPairId !== binding!.pairId || typeof saved.creator !== "boolean") throw new Error("Invalid support channel");
          this.saved = saved;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { this.logicalPairId = undefined; throw error; } }
      }
    }
    return binding;
  }
  private getTransport(secret: string, preserve: boolean) {
    if (!this.directory) throw new Error("No support binding");
    return this.transport ??= this.makeTransport(secret, durableAuthStorage(this.directory), preserve);
  }
  private async persist(saved: SavedChannel) {
    await mkdir(this.directory!, { recursive: true });
    const file = path.join(this.directory!, "channel.json"), temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(saved), { mode: 0o600 });
    await replaceStateFile(temp, file);
    this.saved = saved;
    // Bootstrap alone permits a new anonymous identity. Every later operation
    // must preserve that identity, including within this same app process.
    this.transport?.dispose(); this.transport = undefined;
  }

  context(): Promise<SupportContext | undefined> {
    return this.serial(async () => {
      const binding = await this.load();
      if (!binding || !this.saved) return;
      const saved = this.saved, transport = this.getTransport(saved.invite.encryptionSecret, true);
      const me = await transport.identity();
      if (saved.creator !== (me === saved.creatorId)) throw new Error("Support identity mismatch");
      let pair;
      try { pair = await transport.pairState(saved.invite.pairId); }
      catch (error) {
        if (saved.creator) throw error;
        try { await transport.joinPair(saved.invite); } catch { /* Confirm actual membership after a lost response. */ }
        pair = await transport.pairState(saved.invite.pairId);
      }
      if (pair.owner_id !== saved.creatorId) throw new Error("Support pair owner mismatch");
      const peer = pair.owner_id === me ? pair.partner_id : pair.partner_id === me ? pair.owner_id : undefined;
      if (!peer) return;
      return { transport, pairId: pair.id, me, peer, owner: binding.owner, peerVersion: "1.2.20", independent: true };
    });
  }

  offer(primary: SupportContext): Promise<SupportOffer | undefined> {
    return this.serial(async () => {
      const binding = await this.load();
      if (!binding || primary.pairId !== binding.pairId || primary.me >= primary.peer) return;
      if (!this.saved) {
        const transport = this.getTransport(generateSharedSecret(), false);
        const creatorId = await transport.identity(), invite = await transport.createPair();
        await this.persist({ logicalPairId: binding.pairId, creatorId, invite, creator: true });
      }
      if (!this.saved?.creator) return;
      const { creator: _creator, ...offer } = this.saved;
      return offer;
    });
  }

  accept(primary: SupportContext, offer: unknown): Promise<void> {
    return this.serial(async () => {
      const binding = await this.load();
      if (!binding || !validOffer(offer) || offer.logicalPairId !== binding.pairId || primary.pairId !== binding.pairId
        || primary.me <= primary.peer) return;
      if (this.saved) return; // A repeated/replaced offer never resets a working support identity.
      const transport = this.getTransport(offer.invite.encryptionSecret, false);
      await transport.identity(); // Commit a separate identity before committing its invitation.
      await this.persist({ ...offer, creator: false });
      await this.getTransport(offer.invite.encryptionSecret, true).joinPair(offer.invite);
    });
  }
  dispose() { this.transport?.dispose(); }
}
