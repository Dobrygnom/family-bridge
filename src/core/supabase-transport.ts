import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";

export interface AuthStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}
import { decryptPayload, encryptPayload, generateSharedSecret, hashInviteSecret } from "./encryption.js";
import type { AgentId } from "./types.js";

export interface PairingInvite {
  version: 1;
  pairId: string;
  inviteSecret: string;
  encryptionSecret: string;
}

export interface RemoteEnvelope<T = unknown> {
  id: string;
  pair_id: string;
  conversation_id: string;
  sequence_number: number;
  sender_id: string;
  recipient_id: string;
  sender_agent: AgentId;
  payload: T;
  status: "pending" | "claimed" | "processed" | "failed";
  created_at: string;
}

export interface PairState {
  id: string;
  owner_id: string;
  partner_id: string | null;
}

export class SupabaseTransport {
  private readonly client: SupabaseClient;
  private channel?: RealtimeChannel;

  constructor(
    url: string,
    publishableKey: string,
    private readonly encryptionSecret: string,
    storage?: AuthStorage,
  ) {
    this.client = createClient(url, publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, storage },
    });
  }

  async ensureAnonymousIdentity(): Promise<string> {
    const existing = await this.client.auth.getUser();
    if (existing.data.user) return existing.data.user.id;
    const created = await this.client.auth.signInAnonymously();
    if (created.error || !created.data.user) throw created.error ?? new Error("Anonymous sign-in failed");
    return created.data.user.id;
  }

  async createPair(): Promise<PairingInvite> {
    await this.ensureAnonymousIdentity();
    const inviteSecret = generateSharedSecret();
    const encryptionSecret = this.encryptionSecret || generateSharedSecret();
    const result = await this.client.rpc("create_family_pair", {
      requested_invite_hash: hashInviteSecret(inviteSecret),
    });
    if (result.error) throw result.error;
    return { version: 1, pairId: String(result.data), inviteSecret, encryptionSecret };
  }

  async joinPair(invite: PairingInvite): Promise<void> {
    await this.ensureAnonymousIdentity();
    const result = await this.client.rpc("join_family_pair", {
      requested_pair_id: invite.pairId,
      requested_invite_hash: hashInviteSecret(invite.inviteSecret),
    });
    if (result.error) throw result.error;
  }

  async pairState(pairId: string): Promise<PairState> {
    const result = await this.client.rpc("get_family_pair", { requested_pair_id: pairId });
    if (result.error) throw result.error;
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!row) throw new Error("Pair not found");
    return row as PairState;
  }

  async identity(): Promise<string> {
    return this.ensureAnonymousIdentity();
  }

  async send(input: {
    pairId: string;
    conversationId: string;
    sequence: number;
    recipientId: string;
    senderAgent: AgentId;
    payload: unknown;
    idempotencyKey: string;
  }): Promise<string> {
    const userId = await this.ensureAnonymousIdentity();
    const result = await this.client
      .from("bridge_messages")
      .insert({
        pair_id: input.pairId,
        conversation_id: input.conversationId,
        sequence_number: input.sequence,
        sender_id: userId,
        recipient_id: input.recipientId,
        sender_agent: input.senderAgent,
        encrypted_payload: encryptPayload(input.payload, this.encryptionSecret),
        idempotency_key: input.idempotencyKey,
      })
      .select("id")
      .single();
    if (result.error) throw result.error;
    return String(result.data.id);
  }

  async claimNext(pairId: string): Promise<RemoteEnvelope | null> {
    const result = await this.client.rpc("claim_next_bridge_message", {
      requested_pair_id: pairId,
    });
    if (result.error) throw result.error;
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!row) return null;
    return { ...row, payload: decryptPayload(row.encrypted_payload, this.encryptionSecret) } as RemoteEnvelope;
  }

  async acknowledge(messageId: string): Promise<void> {
    const result = await this.client.rpc("ack_bridge_message", { requested_message_id: messageId });
    if (result.error) throw result.error;
  }

  subscribe(pairId: string, onWake: () => void): () => Promise<unknown> {
    this.channel = this.client
      .channel(`family-pair:${pairId}`, { config: { private: true } })
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "bridge_messages", filter: `pair_id=eq.${pairId}` },
        () => onWake(),
      )
      .subscribe();
    return () => this.client.removeChannel(this.channel!);
  }
}
