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
  historicalDelivery?: boolean;
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
  private lastPairRefresh = 0;
  private pairRefresh?: Promise<unknown>;

  constructor(
    url: string,
    publishableKey: string,
    private readonly encryptionSecret: string,
    storage?: AuthStorage,
    private readonly preserveIdentity = false,
  ) {
    this.client = createClient(url, publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, storage },
      global: { fetch: (input, init) => fetch(input, { ...init,
        signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]) }) },
    });
  }

  async ensureAnonymousIdentity(): Promise<string> {
    const session = await this.client.auth.getSession();
    if (session.error) throw session.error;
    const existing = await this.client.auth.getUser();
    if (existing.data.user) return existing.data.user.id;
    // A failed refresh/network request is NOT a first installation. Replacing
    // an anonymous identity strands the existing pair and its message queue.
    if (this.preserveIdentity || session.data.session || existing.error && existing.error.name !== "AuthSessionMissingError") {
      throw new Error("Не удалось восстановить авторизацию подключения. Прежняя пара сохранена; новая учётная запись не создаётся.");
    }
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
    // Await auth initialization/refresh before asking an RLS-protected RPC.
    // An anonymous RPC can return an empty result for a perfectly intact pair.
    const session = await this.client.auth.getSession();
    if (session.error) throw session.error;
    if (!session.data.session) throw new Error("Нет действующей авторизации подключения. Прежняя пара сохранена.");
    let result = await this.client.rpc("get_family_pair", { requested_pair_id: pairId });
    const empty = (value: typeof result) => !value.error && !(Array.isArray(value.data) ? value.data[0] : value.data);
    if (empty(result) || result.error?.code === "PGRST301" || result.error?.code === "PGRST303") {
      // Refresh only the EXISTING identity; never join/create a pair to repair
      // authorization. Coalesce concurrent polling/health/version requests.
      if (this.pairRefresh || Date.now() - this.lastPairRefresh >= 60_000) {
        if (!this.pairRefresh) {
          this.lastPairRefresh = Date.now();
          this.pairRefresh = this.client.auth.refreshSession().then(({error})=>{if(error)throw error;}).finally(()=>{this.pairRefresh=undefined;});
        }
        await this.pairRefresh;
        result = await this.client.rpc("get_family_pair", { requested_pair_id: pairId });
      }
    }
    if (result.error) throw result.error;
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!row) throw new Error("Текущая авторизация не даёт доступа к сохранённой паре. Подключение не сброшено.");
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
    if (result.error?.code === "23505") {
      // A successful send followed by a lost HTTP response must be retryable.
      const existing = await this.client.from("bridge_messages").select("id,pair_id,conversation_id,sequence_number,sender_id")
        .eq("idempotency_key", input.idempotencyKey).single();
      const row = existing.data;
      if (!existing.error && row?.pair_id === input.pairId && row.conversation_id === input.conversationId && row.sequence_number === input.sequence && row.sender_id === userId) return String(row.id);
    }
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

  async readConversation(pairId: string, conversationId: string): Promise<RemoteEnvelope[]> {
    const result = await this.client.from("bridge_messages").select("*")
      .eq("pair_id", pairId).eq("conversation_id", conversationId)
      .order("sequence_number", { ascending: true }).limit(100);
    if (result.error) throw result.error;
    return result.data.map(row=>({ ...row, payload:decryptPayload(row.encrypted_payload,this.encryptionSecret) }) as RemoteEnvelope);
  }

  async readSupportMessages(pairId: string, since: string): Promise<RemoteEnvelope[]> {
    const me = await this.identity();
    const result = await this.client.from("bridge_messages").select("*")
      .eq("pair_id", pairId).eq("recipient_id", me).gte("created_at", since)
      .like("idempotency_key", "%support-v1:%").order("created_at", { ascending: false }).limit(100);
    if (result.error) throw result.error;
    return result.data.flatMap(row => {
      try { return [{ ...row, payload: decryptPayload(row.encrypted_payload, this.encryptionSecret) } as RemoteEnvelope]; }
      catch { return []; } // One malformed envelope must not disable support.
    }).reverse();
  }

  async readPendingSent(pairId: string): Promise<Array<RemoteEnvelope & { idempotencyKey: string }>> {
    const me = await this.identity();
    const rows: Array<RemoteEnvelope & { idempotencyKey: string }> = [];
    for (let offset = 0; ; offset += 500) {
      const result = await this.client.from("bridge_messages").select("*")
        .eq("pair_id", pairId).eq("sender_id", me).in("status", ["pending", "claimed"])
        .order("created_at", { ascending: true }).order("id", { ascending: true }).range(offset, offset + 499);
      if (result.error) throw result.error;
      rows.push(...result.data.map(row => ({ ...row, idempotencyKey: row.idempotency_key,
        payload: decryptPayload(row.encrypted_payload, this.encryptionSecret) } as RemoteEnvelope & { idempotencyKey: string })));
      if (result.data.length < 500) return rows;
    }
  }

  async readClaimedReceived(pairId: string): Promise<RemoteEnvelope | null> {
    const me = await this.identity();
    const result = await this.client.from("bridge_messages").select("*")
      .eq("pair_id", pairId).eq("recipient_id", me).eq("status", "claimed")
      .order("created_at", { ascending: true }).limit(1);
    if (result.error) throw result.error;
    const row = result.data[0];
    return row ? { ...row, payload: decryptPayload(row.encrypted_payload, this.encryptionSecret) } as RemoteEnvelope : null;
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

  dispose(): void {
    void this.client.auth.stopAutoRefresh();
    void this.client.removeAllChannels();
  }
}
