import { SupabaseTransport, type RemoteEnvelope, type AuthStorage, type PairState } from "./supabase-transport.js";
import { recoveryConversationId, type PairRecovery } from "./pair-recovery.js";
import type { AgentId } from "./types.js";

type SendInput = Parameters<SupabaseTransport["send"]>[0];
interface RecoveryPayload { transport: "recovery-v1"; conversationId: string; originalEnvelopeId?: string; payload: unknown }

// Preserve logical pair/conversation IDs: reports, pending owner answers,
// continuations and topic selections remain attached to their original history.
export class RecoveryTransport extends SupabaseTransport {
  private connecting?: Promise<PairState>;
  private readonly acknowledgements = new Map<string, string>();
  private copiedPending = false;

  constructor(url: string, key: string, private readonly secret: string, storage: AuthStorage | undefined,
    private readonly route: PairRecovery, private readonly participant: AgentId) {
    // Only the invited participant may create a replacement identity, and only
    // under a capsule authenticated by the existing pair's encryption key.
    super(url, key, secret, storage, participant === route.creatorAgent);
  }

  override async identity(): Promise<string> {
    const id = await super.identity();
    if ((this.participant === this.route.creatorAgent) !== (id === this.route.creatorAuthId)) {
      throw new Error("Не совпадает участник восстановления подключения. История сохранена.");
    }
    return id;
  }

  override async pairState(pairId: string): Promise<PairState> {
    this.assertPair(pairId);
    if (!this.connecting) this.connecting = this.connect().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async connect(): Promise<PairState> {
    const me = await this.identity();
    let pair: PairState;
    try { pair = await super.pairState(this.route.transportPairId); }
    catch (error) {
      if (this.participant === this.route.creatorAgent) throw error;
      // Reusing an already-consumed invitation is harmless: after a lost HTTP
      // response, confirm membership instead of replacing another account.
      try { await super.joinPair({ version: 1, pairId: this.route.transportPairId, inviteSecret: this.route.inviteSecret, encryptionSecret: this.secret }); }
      catch { /* The membership read below is authoritative. */ }
      pair = await super.pairState(this.route.transportPairId);
    }
    if (pair.owner_id !== this.route.creatorAuthId) throw new Error("Recovery pair owner mismatch");
    if (pair.partner_id && !this.copiedPending) {
      const recipientId = pair.owner_id === me ? pair.partner_id : pair.owner_id;
      // The still-authorized sender can rescue its undelivered old queue.
      // The original envelope ID preserves inbox deduplication on the peer.
      const rows = await super.readPendingSent(this.route.logicalPairId);
      for (const row of rows) {
        const payload = row.payload as { topic?: string; versionOnly?: boolean };
        if (payload.versionOnly || payload.topic?.startsWith("family-bridge:version:")) continue;
        await this.sendRecovered({ pairId: this.route.logicalPairId, conversationId: row.conversation_id,
          sequence: row.sequence_number, recipientId, senderAgent: row.sender_agent,
          payload: row.payload, idempotencyKey: row.idempotencyKey }, row.id);
      }
      this.copiedPending = true;
    }
    return { ...pair, id: this.route.logicalPairId };
  }

  private assertPair(pairId: string) {
    if (pairId !== this.route.logicalPairId) throw new Error("Recovery route does not match saved pair");
  }

  override async send(input: SendInput): Promise<string> { return this.sendRecovered(input); }
  private async sendRecovered(input: SendInput, originalEnvelopeId?: string): Promise<string> {
    this.assertPair(input.pairId);
    await this.identity();
    return super.send({ ...input, pairId: this.route.transportPairId,
      conversationId: recoveryConversationId(this.route, input.conversationId),
      idempotencyKey: `recovery:${this.route.transportPairId}:${input.idempotencyKey}`,
      payload: { transport: "recovery-v1", conversationId: input.conversationId, originalEnvelopeId, payload: input.payload } satisfies RecoveryPayload });
  }

  private unwrap(row: RemoteEnvelope): RemoteEnvelope {
    if (row.pair_id === this.route.logicalPairId) return { ...row, historicalDelivery: true };
    const p = row.payload as RecoveryPayload;
    if (row.pair_id !== this.route.transportPairId || p?.transport !== "recovery-v1"
      || recoveryConversationId(this.route, p.conversationId) !== row.conversation_id) throw new Error("Invalid recovery envelope");
    if (p.originalEnvelopeId) this.acknowledgements.set(p.originalEnvelopeId, row.id);
    return { ...row, historicalDelivery: Boolean(p.originalEnvelopeId), id: p.originalEnvelopeId ?? row.id, pair_id: this.route.logicalPairId,
      conversation_id: p.conversationId, payload: p.payload };
  }

  override async claimNext(pairId: string): Promise<RemoteEnvelope | null> {
    this.assertPair(pairId);
    const row = await super.claimNext(this.route.transportPairId);
    if (row) return this.unwrap(row);
    // Old in-flight messages addressed to an identity which survived the
    // upgrade can still be consumed. No old pair or queue is deleted.
    const legacy = await super.claimNext(this.route.logicalPairId)
      ?? await super.readClaimedReceived(this.route.logicalPairId)
      ?? await super.readClaimedReceived(this.route.transportPairId);
    return legacy && this.unwrap(legacy);
  }
  override async readSupportMessages(pairId: string, since: string): Promise<RemoteEnvelope[]> {
    this.assertPair(pairId);
    return (await super.readSupportMessages(this.route.transportPairId, since)).flatMap(row => {
      try { return [this.unwrap(row)]; } catch { return []; }
    });
  }
  override async acknowledge(id: string): Promise<void> {
    await super.acknowledge(this.acknowledgements.get(id) ?? id);
    this.acknowledgements.delete(id);
  }
  override async readConversation(pairId: string, conversationId: string): Promise<RemoteEnvelope[]> {
    this.assertPair(pairId);
    const fresh = (await super.readConversation(this.route.transportPairId, recoveryConversationId(this.route, conversationId))).map(row => this.unwrap(row));
    const old = await super.readConversation(pairId, conversationId);
    const bySequence = new Map(old.map(row => [row.sequence_number, row]));
    for (const row of fresh) bySequence.set(row.sequence_number, row);
    return [...bySequence.values()].sort((a, b) => a.sequence_number - b.sequence_number);
  }
  override subscribe(pairId: string, onWake: () => void): () => Promise<unknown> {
    this.assertPair(pairId);
    return super.subscribe(this.route.transportPairId, onWake);
  }
}
