import type { Language } from "./i18n.js";
import { PendingStatus } from "./PendingStatus.js";

interface Props {
  language: Language;
  text: { instruction: string; instructionPlaceholder: string; prepare: string; preparing: string; cancel: string };
  instruction: string;
  pending: boolean;
  ready: boolean;
  onChange: (value: string) => void;
  onRefine: () => void;
  onCancel: () => void;
}

export function TopicRefinementRequest({ language, text, instruction, pending, ready, onChange, onRefine, onCancel }: Props) {
  return <div className="topic-refinement-request">
    <label>{text.instruction}<textarea value={instruction} maxLength={4000} placeholder={text.instructionPlaceholder} disabled={pending} onChange={(event) => onChange(event.target.value)} /></label>
    {!ready && <div className="actions topic-refinement-actions">
      <button type="button" className="primary" disabled={pending || !instruction.trim()} aria-busy={pending} onClick={onRefine}>{text.prepare}</button>
      <button type="button" className="ghost" disabled={pending} onClick={onCancel}>{text.cancel}</button>
    </div>}
    {pending && <PendingStatus language={language}>{text.preparing}</PendingStatus>}
  </div>;
}
