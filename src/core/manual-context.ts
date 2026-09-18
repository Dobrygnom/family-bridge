import { createHash } from "node:crypto";
import { CONTEXT_ANALYSIS_VERSION, contextSourceHash, type AnalysisMessage, type ContextAnalysis } from "./context-analysis.js";

export interface ManualContextInput {
  ownerName: string;
  partnerName: string;
  relationship?: string;
  background?: string;
  communicationExamples?: string;
}

const clean = (value: unknown, maximum: number, required = false) => {
  const text = typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
  if (required && !text) throw new Error("Заполните обязательные поля");
  if (text.length > maximum) throw new Error(`Текст должен быть не длиннее ${maximum} символов`);
  return text;
};

const personId = (name: string) => `person-${createHash("sha256").update(name.toLocaleLowerCase()).digest("hex").slice(0, 12)}`;

export function prepareManualContext(value: unknown, now = new Date().toISOString()) {
  const input = value && typeof value === "object" ? value as Partial<ManualContextInput> : {};
  const ownerName = clean(input.ownerName, 50, true);
  const partnerName = clean(input.partnerName, 50, true);
  const relationship = clean(input.relationship, 100) || "Близкий человек";
  const background = clean(input.background, 20_000);
  const communicationExamples = clean(input.communicationExamples, 20_000);
  if (ownerName.toLocaleLowerCase() === partnerName.toLocaleLowerCase()) throw new Error("Укажите разные имена участников");

  const samples: AnalysisMessage[] = communicationExamples
    .split(/\n\s*\n/)
    .map(text => text.trim())
    .filter(Boolean)
    .slice(0, 40)
    .map(text => ({ text }));
  const id = `manual-${createHash("sha256").update(`${ownerName}\u0000${partnerName}\u0000${now}`).digest("hex").slice(0, 20)}`;
  const partnerId = personId(partnerName);
  const sourceHash = contextSourceHash(samples);
  const source = {
    id,
    title: "Профиль без исходного чата",
    project: "Family Bridge",
    source: "manual" as const,
    status: "ready" as const,
    lastSyncedAt: now,
    messageCount: samples.length,
  };
  const analysis: ContextAnalysis = {
    analysisVersion: CONTEXT_ANALYSIS_VERSION,
    sourceId: id,
    sourceHash,
    analyzedAt: now,
    status: "ready",
    people: [{ id: partnerId, label: partnerName, relationship, aliases: [] }],
    portraits: [
      { personId: "owner", label: ownerName, relationship: "Вы", isOwner: true, observations: [], updatedAt: now },
      { personId: partnerId, label: partnerName, relationship, isOwner: false, observations: [], updatedAt: now },
    ],
    topics: [],
  };
  const profile = [
    "# Личный профиль Family Bridge",
    "",
    "Эти сведения явно введены владельцем приложения. Они могут быть неполными и не являются объективным описанием другого человека.",
    "",
    `Имя владельца: ${ownerName}`,
    `Собеседник: ${partnerName}`,
    `Отношение: ${relationship}`,
    background ? `\nЧто владелец считает важным:\n${background}` : "",
  ].filter(Boolean).join("\n");
  return { ownerName, partnerName, partnerId, source, analysis, samples, profile };
}
