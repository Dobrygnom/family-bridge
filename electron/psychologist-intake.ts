import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { replaceStateFile } from "./store.js";

export type IntakeRoute = "local" | "trusted";
export interface IntakeMessage { id: string; role: "user" | "assistant"; text: string; createdAt: string }
export interface IntakeState {
  version: 1;
  route: IntakeRoute;
  status: "idle" | "waiting" | "ready" | "finalizing" | "complete" | "error";
  messages: IntakeMessage[];
  sessionId?: string;
  pendingMessageId?: string;
  error?: string;
  analysis?: unknown;
}

export interface IntakeExecutor {
  run(input: { route: IntakeRoute; key: string; schema: "intake-response" | "context-analysis"; prompt: string; sessionId?: string }): Promise<{ value: unknown; sessionId?: string }>;
}

const initialPrompt = (language: string) => `Ты проводишь спокойный первый разговор, чтобы Family Bridge понял жизненный контекст человека и позже предложил ему темы для разговора с близкими.
Это не анкета и не медицинская диагностика. Разговаривай естественно, бережно и по существу на языке ${language}. Задавай ровно один наиболее уместный вопрос за раз. Не проси заполнять поля или перечислять всё сразу. Уточняй имена, отношения, важные события, устойчивые трудности, желания и стиль общения только тогда, когда это естественно следует из ответа.
Поле ready ставь true, когда уже достаточно контекста, чтобы выделить людей и несколько конкретных тем; не растягивай интервью ради полноты. message — только следующая живая реплика собеседнику.`;

const nextPrompt = (text: string) => `Ответ человека:
${text}

Отреагируй по-человечески и задай один следующий наиболее полезный вопрос. Если контекста уже достаточно, кратко скажи, что можно переходить к подготовке тем, и поставь ready=true.`;

const finalPrompt = `На основе всего нашего разговора подготовь структурированный контекст Family Bridge. Не ставь диагнозов и не выдавай гипотезы за факты. В people включи самого отвечающего с key="owner" и relationship="self", а также всех важных упомянутых людей. В portraits разделяй факты, мнения, предпочтения, повторяющиеся паттерны и неопределённость. В topics предложи конкретные вопросы для разговора владельца с другим человеком. discuss_with должен быть точным key этого другого человека из people, никогда "owner"; элементы about_people также должны быть key из people. Если другой человек не назван, верни topics пустым. Верни только JSON по схеме.`;

function cleanText(value: unknown, maximum = 20_000) {
  const text = typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
  if (!text) throw new Error("Напишите ответ");
  if (text.length > maximum) throw new Error(`Текст должен быть не длиннее ${maximum} символов`);
  return text;
}

export class PsychologistIntake {
  private state: IntakeState;
  private inFlight = false;
  constructor(private readonly file: string, private readonly executor: IntakeExecutor) {
    let saved: string;
    try { saved = readFileSync(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Не удалось прочитать сохранённый разговор. Данные не сброшены.");
      this.state = { version: 1, route: "local", status: "idle", messages: [] };
      return;
    }
    try {
      const state = JSON.parse(saved) as IntakeState;
      if (state?.version !== 1 || !["local", "trusted"].includes(state.route)
        || !["idle", "waiting", "ready", "finalizing", "complete", "error"].includes(state.status)
        || !Array.isArray(state.messages)
        || state.messages.some(message => !message || typeof message.id !== "string"
          || !["user", "assistant"].includes(message.role) || typeof message.text !== "string"
          || typeof message.createdAt !== "string")
        || state.sessionId !== undefined && typeof state.sessionId !== "string"
        || state.pendingMessageId !== undefined && typeof state.pendingMessageId !== "string") throw new Error("Invalid saved intake");
      this.state = state;
    } catch { throw new Error("Не удалось прочитать сохранённый разговор. Данные не сброшены."); }
  }

  snapshot(): Omit<IntakeState, "analysis"> {
    const { analysis: _analysis, ...state } = this.state;
    return structuredClone(state);
  }

  private async save() {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state, null, 2), { encoding: "utf8", mode: 0o600 });
    await replaceStateFile(temporary, this.file);
  }

  async start(route: IntakeRoute, language = "ru") {
    if (this.inFlight) throw new Error("Разговор сейчас занят");
    this.inFlight = true;
    try {
      if (!["local", "trusted"].includes(route)) throw new Error("Некорректный способ обработки");
      if (this.state.status !== "idle" && this.state.route === route && this.state.messages.length) return this.snapshot();
      this.state = { version: 1, route, status: "waiting", messages: [] };
      await this.save();
      return await this.runAssistant(initialPrompt(language), "start");
    } finally { this.inFlight = false; }
  }

  async send(value: unknown) {
    if (this.inFlight) throw new Error("Разговор сейчас занят");
    this.inFlight = true;
    try {
      if (!["waiting", "ready", "error"].includes(this.state.status)) throw new Error("Разговор сейчас занят");
      const text = cleanText(value);
      // A failed delivery already has a durable user turn. Retry or edit that exact
      // turn rather than appending a duplicate to the psychological transcript.
      let message = this.state.pendingMessageId
        ? this.state.messages.find(item => item.id === this.state.pendingMessageId && item.role === "user")
        : undefined;
      if (message) message.text = text;
      else {
        message = { id: randomUUID(), role: "user", text, createdAt: new Date().toISOString() };
        this.state.messages.push(message);
      }
      this.state.pendingMessageId = message.id;
      this.state.status = "waiting";
      this.state.error = undefined;
      // The user's plaintext is durably committed before any network or model call.
      await this.save();
      return await this.runAssistant(nextPrompt(text), message.id);
    } finally { this.inFlight = false; }
  }

  async resumePending() {
    if (this.inFlight || !this.state.pendingMessageId) return this.snapshot();
    const pending = this.state.messages.find(message => message.id === this.state.pendingMessageId && message.role === "user");
    if (!pending) throw new Error("Сохранённая реплика не найдена; данные не сброшены");
    return this.send(pending.text);
  }

  private async runAssistant(prompt: string, turn: string) {
    try {
      const key = createHash("sha256").update(JSON.stringify([this.state.route, this.state.sessionId, turn, prompt])).digest("hex");
      const result = await this.executor.run({ route: this.state.route, key, schema: "intake-response", prompt, sessionId: this.state.sessionId });
      const value = result.value as { message?: unknown; ready?: unknown };
      const text = cleanText(value?.message, 4_000);
      this.state.messages.push({ id: randomUUID(), role: "assistant", text, createdAt: new Date().toISOString() });
      this.state.sessionId = result.sessionId ?? this.state.sessionId;
      this.state.pendingMessageId = undefined;
      this.state.status = value.ready === true ? "ready" : "waiting";
      this.state.error = undefined;
      await this.save();
      return this.snapshot();
    } catch (error) {
      this.state.status = "error";
      this.state.error = error instanceof Error ? error.message : String(error);
      await this.save();
      throw error;
    }
  }

  async finalize() {
    if (this.inFlight) throw new Error("Разговор сейчас занят");
    this.inFlight = true;
    try {
      if (this.state.status === "complete" && this.state.analysis !== undefined) return structuredClone(this.state.analysis);
      if (this.state.pendingMessageId) throw new Error("Сначала повторите отправку сохранённой реплики");
      if (!this.state.sessionId || this.state.messages.length < 2) throw new Error("Сначала расскажите немного о ситуации");
      this.state.status = "finalizing";
      await this.save();
      try {
        const key = createHash("sha256").update(JSON.stringify([this.state.route, this.state.sessionId, "finalize"])).digest("hex");
        const result = await this.executor.run({ route: this.state.route, key, schema: "context-analysis", prompt: finalPrompt, sessionId: this.state.sessionId });
        // Save the model result before derived profile files are written. If the
        // process is interrupted afterwards, finalization resumes without another
        // model call and without losing the result.
        this.state.analysis = result.value;
        this.state.status = "complete";
        this.state.pendingMessageId = undefined;
        this.state.error = undefined;
        await this.save();
        return result.value;
      } catch (error) {
        this.state.status = "error";
        this.state.error = error instanceof Error ? error.message : String(error);
        await this.save();
        throw error;
      }
    } finally { this.inFlight = false; }
  }

  async reset() {
    if (this.inFlight) throw new Error("Разговор сейчас занят");
    this.state = { version: 1, route: this.state.route, status: "idle", messages: [] };
    await this.save();
    return this.snapshot();
  }
}
