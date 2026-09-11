import { useState } from "react";
import { Download, LoaderCircle } from "lucide-react";
import type { AppState } from "../global.js";
import type { Language } from "./i18n.js";

const labels = {
  ru: { current:"Установлена версия", check:"Проверить обновления", checking:"Проверяем обновления…", download:"Скачиваем версию", ready:"Готова версия", install:"Обновить сейчас", installing:"Устанавливаем обновление…", requested:"Запрошена установка сейчас", auto:"Обновление установится автоматически. Можно установить сейчас.", restart:"Приложение перезапустится. Разговоры и сохранённые черновики останутся.", dictation:"Закончите или отмените запись голоса — после этого установим обновление.", editing:"Сохраните или отмените редактирование в приложении — затем обновление продолжится.", activity:"Ждём завершения действия в приложении. Установка продолжится автоматически.", background:"Ждём сохранения данных и завершения текущей работы агента. Установка продолжится автоматически.", error:"Не удалось обновиться. Повторите попытку." },
  en: { current:"Installed version", check:"Check for updates", checking:"Checking for updates…", download:"Downloading version", ready:"Version ready", install:"Update now", installing:"Installing update…", requested:"Install now requested", auto:"The update will install automatically. You can install it now.", restart:"The app will restart. Conversations and saved drafts will stay.", dictation:"Finish or cancel the voice recording to install the update.", editing:"Save or cancel editing in the app to continue updating.", activity:"Waiting for the current app action to finish. Installation will continue automatically.", background:"Waiting for data to be saved and the current agent task to finish. Installation will continue automatically.", error:"Could not update. Please retry." },
  cs: { current:"Nainstalovaná verze", check:"Zkontrolovat aktualizace", checking:"Kontrolujeme aktualizace…", download:"Stahujeme verzi", ready:"Připravená verze", install:"Aktualizovat nyní", installing:"Instalujeme aktualizaci…", requested:"Požadována okamžitá instalace", auto:"Aktualizace se nainstaluje automaticky. Můžete ji nainstalovat nyní.", restart:"Aplikace se restartuje. Rozhovory a uložené koncepty zůstanou.", dictation:"Dokončete nebo zrušte nahrávání hlasu, pak se aktualizace nainstaluje.", editing:"Uložte nebo zrušte úpravy v aplikaci, pak bude aktualizace pokračovat.", activity:"Čekáme na dokončení akce v aplikaci. Instalace bude pokračovat automaticky.", background:"Čekáme na uložení dat a dokončení práce agenta. Instalace bude pokračovat automaticky.", error:"Aktualizace se nezdařila. Zkuste to znovu." },
  fr: { current:"Version installée", check:"Vérifier les mises à jour", checking:"Recherche de mises à jour…", download:"Téléchargement de la version", ready:"Version prête", install:"Mettre à jour maintenant", installing:"Installation de la mise à jour…", requested:"Installation immédiate demandée", auto:"La mise à jour sera automatique. Vous pouvez l’installer maintenant.", restart:"L’application redémarrera. Les conversations et les brouillons enregistrés resteront.", dictation:"Terminez ou annulez l’enregistrement vocal pour installer la mise à jour.", editing:"Enregistrez ou annulez vos modifications pour poursuivre la mise à jour.", activity:"En attente de la fin de l’action dans l’application. L’installation reprendra automatiquement.", background:"En attente de l’enregistrement des données et de la fin du travail de l’agent. L’installation reprendra automatiquement.", error:"Échec de la mise à jour. Réessayez." },
};

export function UpdateControl({ update, version, language, onCheck, onInstall, compact = false }: {
  update: AppState["update"]; version: string; language: Language; onCheck: () => Promise<unknown>; onInstall: () => Promise<unknown>; compact?: boolean;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const t = labels[language];
  async function act(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : t.error); }
    finally { setBusy(false); }
  }
  if (compact) {
    if (!update.available && !update.ready && !update.downloading && !update.installing) return null;
    const pending = busy || update.checking || update.downloading || update.installing;
    const caption = update.installing ? t.installing : update.downloading ? `${t.download} · ${Math.round(update.progress ?? 0)}%`
      : update.checking ? t.checking : update.ready ? t.install
      : { ru: "Обновить приложение", en: "Update app", cs: "Aktualizovat aplikaci", fr: "Mettre à jour l’application" }[language];
    return <div className={`sidebar-update ${update.available || update.ready ? "update-available" : ""}`} aria-live="polite">
      {update.version && (update.available || update.ready) && <strong>{update.ready ? t.ready : { ru: "Доступна версия", en: "Version available", cs: "Dostupná verze", fr: "Version disponible" }[language]} {update.version}</strong>}
      <button disabled={pending} aria-busy={pending} onClick={() => void act(update.ready ? onInstall : onCheck)}>
        {pending ? <LoaderCircle className="spin" size={17}/> : <Download size={17}/>}<span>{caption}</span>
      </button>
      {update.waitingFor && <small>{t[update.waitingFor]}</small>}
      {(error || update.error) && <small role="alert">{error || update.error}</small>}
    </div>;
  }
  return <div className="update-card" aria-live="polite">
    <small>{t.current} {version}</small>
    {update.checking && <div className="update-status" role="status"><LoaderCircle className="spin" size={18}/><strong>{t.checking}</strong></div>}
    {update.downloading && <div className="update-download"><div className="update-status"><LoaderCircle className="spin" size={18}/><strong>{t.download} {update.version}</strong><b>{update.progress ?? 0}%</b></div><progress max="100" value={update.progress ?? 0}/></div>}
    {update.ready && <div className="update-status update-ready"><Download size={18}/><div><strong>{update.installing ? t.installing : `${t.ready} ${update.version}`}</strong>
      <small>{update.waitingFor ? t[update.waitingFor] : update.installRequested ? t.requested : t.auto}</small><small>{t.restart}</small>
      <button className="primary" disabled={busy || update.installing} aria-busy={busy || update.installing} onClick={() => void act(onInstall)}>{(busy || update.installing) && <LoaderCircle className="spin" size={16}/>} {update.installing ? t.installing : t.install}</button>
    </div></div>}
    {(error || update.error) && <p className="analysis-error" role="alert">{error || update.error}</p>}
    {update.available && !update.ready && !update.downloading && <button disabled={busy || update.checking} onClick={() => void act(onCheck)}>{t.install}</button>}
  </div>;
}
