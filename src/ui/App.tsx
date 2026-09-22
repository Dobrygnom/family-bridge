import { NewTopicComposer } from "./NewTopicComposer.js";
import { errorMessage } from "../core/error-message.js";
import { useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { UpdateControl } from "./UpdateControl.js";
import {
  Activity,
  Ban,
  Bell,
  BookHeart,
  Check,
  ChevronDown,
  CircleDot,
  LoaderCircle,
  MessageCircleHeart,
  Plus,
  Radio,
  RefreshCw,
  ScrollText,
  Settings2,
  ShieldCheck,
  Sparkles,
  Pencil,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import type { AppState } from "../global.js";
import { suggestedTopics, topicAlreadyStarted } from "../core/topic-suggestions.js";
import { languageNames, translations, type Language } from "./i18n.js";
import { DictationControl } from "./DictationControl.js";
import { PeerVersionControl } from "./PeerVersionControl.js";
import { ConversationThreads } from "./ConversationThreads.js";
import { useConversationReading } from "./useConversationReading.js";
import { attentionLabels } from "../core/conversation-attention.js";
import { applyConversationUpdate, keepNewerConversations, type ConversationUpdateEvent } from "../core/conversation-updates.js";
import { dictationText } from "./dictation-text.js";
import { appendDictation } from "../core/dictation.js";
import { OWNER_DRAFTS_KEY, parseOwnerDrafts } from "./drafts.js";
import { PendingStatus } from "./PendingStatus.js";
import { TopicRefinementRequest } from "./TopicRefinementRequest.js";
import { loadSavedState } from "./load-state.js";
import { topicNeedsReview, topicRelevanceLabel } from "../core/topic-review.js";
import { shareableTopicBrief, topicKey } from "../core/conversation-quality.js";
import { clearRecoveredConnectionError } from "./connection-error.js";
import { CODEX_MODELS, CODEX_REASONING_EFFORTS, supportsCodexConfig, type CodexModel, type CodexReasoningEffort } from "../core/codex-settings.js";

const fallback: AppState = {
  owner: "dima",
  onboardingComplete: false,
  identityConfigured: false,
  displayName: "",
  language: "ru",
  autoStart: true,
  codexModel: "gpt-5.6-sol",
  codexReasoningEffort: "medium",
  appVersion: "preview",
  pendingTopics: [],
  pairTopics: [],
  topicSources: {},
  topicBriefs: {},
  activeTopics: [],
  blockedTopics: [],
  reports: [],
  reportSummaries: [],
  ownerQuestions: [],
  running: false,
  contextSyncing: false,
  contextSyncProgress: 0,
  portraitsUpdating: false,
  codex: { installed: false, authenticated: false, version: "" },
  compute: { mode: "off", connected: false, pending: 0, approvalPolicy: "auto_accept", enrollmentStatus: "idle", requests: [], channels: [] },
  intake: { version: 1, route: "local", status: "idle", messages: [] },
  remote: { configured: false, connected: false },
  memory: { configured: false, messageCount: 0, learnedCount: 0 },
  update: { available: false, downloading: false },
};

type SectionId = "overview" | "context" | "people" | "reports" | "settings";

function compareVersions(left: string, right: string) {
  const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

export function App() {
  const [state, dispatchState] = useState<AppState>(fallback);
  function setState(action: SetStateAction<AppState>) {
    dispatchState((current) => typeof action === "function" ? action(current) : keepNewerConversations(current, action));
  }
  const [loaded, setLoaded] = useState(false);
  const reading = useConversationReading(state, loaded, window.familyBridge?.notifyConversation);
  const openConversation = useRef<(id: string) => void>(() => {});
  const [revealToken, setRevealToken] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [newTopicActive, setNewTopicActive] = useState(false);
  const [blocked, setBlocked] = useState("");
  const [busy, setBusy] = useState(false);
  const [connectionAction, setConnectionAction] = useState<"create" | "join" | "">("");
  const [error, setError] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [contextThreads, setContextThreads] = useState<Array<{ id: string; title: string; project: string; source: "codex" | "chatgpt"; cwd?: string; updatedAt?: number }>>([]);
  const [manualContext, setManualContext] = useState({ ownerName: "", partnerName: "", relationship: "", background: "", communicationExamples: "" });
  const [manualContextOpen, setManualContextOpen] = useState(false);
  const [computeCode, setComputeCode] = useState("");
  const [computeInvite, setComputeInvite] = useState("");
  const [computeLabel, setComputeLabel] = useState("");
  const [computeBusy, setComputeBusy] = useState(false);
  const [intakeDraft, setIntakeDraft] = useState("");
  const [selectedContextProject, setSelectedContextProject] = useState("");
  const [selectedContextId, setSelectedContextId] = useState("");
  const [contextLoading, setContextLoading] = useState(false);
  const [showContextPicker, setShowContextPicker] = useState(false);
  const [counterpartPersonId, setCounterpartPersonId] = useState("");
  const [reviewPersonId, setReviewPersonId] = useState("");
  const [topicFilter, setTopicFilter] = useState<"all" | "review" | "approved" | "dismissed">("all");
  const [topicSearch, setTopicSearch] = useState("");
  const [expandedTopicIds, setExpandedTopicIds] = useState<Set<string>>(() => new Set());
  const [editingTopicId, setEditingTopicId] = useState("");
  const topicEditSession = useRef(0);
  const [topicDraft, setTopicDraft] = useState({ title: "", context: "", goal: "", openingQuestion: "" });
  const [topicRefinementInstruction, setTopicRefinementInstruction] = useState("");
  const [refiningTopicId, setRefiningTopicId] = useState("");
  const [topicRefinementReady, setTopicRefinementReady] = useState(false);
  const [savingTopicId, setSavingTopicId] = useState("");
  const [inviteCopied, setInviteCopied] = useState(false);
  const [ownerAnswers, setOwnerAnswers] = useState<Record<string, string>>(() => {
    try { return parseOwnerDrafts(localStorage.getItem(OWNER_DRAFTS_KEY)); } catch { return {}; }
  });
  const [activeDictation, setActiveDictation] = useState("");
  const [selectedReportId, setSelectedReportId] = useState("");
  const [answeringQuestionId, setAnsweringQuestionId] = useState("");
  const [versionCheckBusy, setVersionCheckBusy] = useState(false);
  const [showAllPairTopics, setShowAllPairTopics] = useState(false);
  const [showAllReviewTopics, setShowAllReviewTopics] = useState(false);
  const [selectedPortraitId, setSelectedPortraitId] = useState("owner");
  const [editingObservationId, setEditingObservationId] = useState("");
  const [observationDraft, setObservationDraft] = useState("");
  const [activeSection, setActiveSection] = useState<SectionId>("overview");
  const [language, setLanguage] = useState<Language>(() => (localStorage.getItem("family-bridge-language") as Language) || "ru");
  const t = translations[language];
  const waitingText = {
    ru: { create: "Создаём приглашение…", join: "Соединяем приложения…", save: "Сохраняем…", context: "Подготавливаем выбранный чат…" },
    en: { create: "Creating invitation…", join: "Connecting apps…", save: "Saving…", context: "Preparing the selected chat…" },
    cs: { create: "Vytváříme pozvánku…", join: "Propojujeme aplikace…", save: "Ukládáme…", context: "Připravujeme vybraný chat…" },
    fr: { create: "Création de l’invitation…", join: "Connexion des applications…", save: "Enregistrement…", context: "Préparation du chat choisi…" },
  }[language];
  const deviceText = {
    ru: { identity: "Участники", local: "этот компьютер", partner: "компьютер собеседника", question: "Как вас называть?", hint: "Это имя будет видно собеседнику в ваших общих разговорах. Его можно изменить в настройках.", placeholder: "Ваше имя", save: "Сохранить", partnerName: "Собеседник", agent: "Помощник" },
    en: { identity: "Participants", local: "this computer", partner: "partner computer", question: "What should we call you?", hint: "Only your partner's agent will see this name. You can change it in settings.", placeholder: "Your name", save: "Save", partnerName: "Partner's agent", agent: "Agent" },
    cs: { identity: "Účastníci", local: "tento počítač", partner: "počítač partnera", question: "Jak vám máme říkat?", hint: "Toto jméno uvidí pouze agent partnera. Lze ho změnit v nastavení.", placeholder: "Vaše jméno", save: "Uložit", partnerName: "Agent partnera", agent: "Agent" },
    fr: { identity: "Participants", local: "cet ordinateur", partner: "ordinateur du partenaire", question: "Comment devons-nous vous appeler ?", hint: "Seul l'agent de votre partenaire verra ce nom. Vous pourrez le modifier.", placeholder: "Votre prénom", save: "Enregistrer", partnerName: "Agent du partenaire", agent: "Agent" },
  }[language];
  const contextText = {
    ru: { eyebrow: "ИСХОДНЫЙ РАЗГОВОР", title: "Что уже знает помощник", none: "Исходный разговор ещё не выбран", explanation: "Из него приложение поймёт ситуацию, важных людей и вашу манеру общения.", project: "Проект", chat: "Разговор", messages: "Ваших сообщений", learned: "Уточнений от вас", synced: "Проверено", choose: "Выбрать разговор", change: "Выбрать другой", refresh: "Найти новые сообщения", loading: "Открываем список разговоров…", apply: "Использовать этот разговор", select: "Выберите проект и разговор" },
    en: { eyebrow: "BASE CHAT", title: "Agent context", none: "No base chat selected", explanation: "The app uses it for context and examples of your communication style.", project: "Project", chat: "Chat", messages: "Your messages", learned: "Learned from answers", synced: "Updated", choose: "Choose chat", change: "Choose another", refresh: "Check for new messages", loading: "Loading chats…", apply: "Use this chat", select: "Choose a project and chat" },
    cs: { eyebrow: "ZÁKLADNÍ CHAT", title: "Kontext agenta", none: "Základní chat ještě není vybrán", explanation: "Aplikace z něj čerpá kontext a příklady vašeho stylu komunikace.", project: "Projekt", chat: "Chat", messages: "Vašich zpráv", learned: "Zapamatováno z odpovědí", synced: "Aktualizováno", choose: "Vybrat chat", change: "Vybrat jiný", refresh: "Zkontrolovat nové zprávy", loading: "Načítání chatů…", apply: "Použít tento chat", select: "Vyberte projekt a chat" },
    fr: { eyebrow: "CHAT DE BASE", title: "Contexte de l’agent", none: "Aucun chat de base sélectionné", explanation: "L’application l’utilise comme contexte et comme exemples de votre manière de communiquer.", project: "Projet", chat: "Chat", messages: "Vos messages", learned: "Appris de vos réponses", synced: "Mis à jour", choose: "Choisir un chat", change: "En choisir un autre", refresh: "Vérifier les nouveaux messages", loading: "Chargement des chats…", apply: "Utiliser ce chat", select: "Choisissez un projet et un chat" },
  }[language];
  const workflowText = {
    ru: { connection: "СВЯЗЬ", link: "Связать два приложения", who: "С кем вы связываете это приложение?", choosePerson: "Выберите человека", create: "Создать код подключения", recreate: "Создать новый код", copy: "Копировать код", copied: "Код скопирован", orJoin: "Или вставьте код с другого компьютера", connect: "Подключиться", connected: "Связь настроена", mapped: "Ваш собеседник", needContext: "Сначала выберите исходный разговор, чтобы приложение нашло важных людей.", openContext: "Выбрать разговор", topics: "ПРЕДЛОЖЕННЫЕ ТЕМЫ", topicTitle: "О чём можно поговорить", topicHint: "Здесь собраны выбранные вами и собеседником темы. До начала разговора любую из них можно проверить или убрать.", localPreview: "Пока здесь только выбранные вами темы. После подключения добавятся темы собеседника.", updatePeer: "Разговор начнётся после обновления Family Bridge на втором компьютере.", noTopics: "С этим человеком пока не выбрано ни одной темы.", addTopic: "Что произошло и что вы хотите понять?", discuss: "Начать выбранные разговоры", discussing: "Помощники ведут разговор…", analysis: "ЛЮДИ И ТЕМЫ", analysisTitle: "Предложения из исходного разговора", analyzing: "Помощник находит важных людей и возможные темы…", noAnalysis: "Здесь появятся найденные люди и темы.", people: "Найденные люди", about: "О ком", with: "Поговорить с", approve: "Выбрать тему", cross: "Тема касается другого человека — особенно внимательно проверьте собеседника.", unclear: "Не удалось уверенно определить собеседника — проверьте его перед выбором темы." },
    en: { connection: "CONNECTION", link: "Link two computers", who: "Who in your context does the other computer belong to?", choosePerson: "Choose a person", create: "Create invitation", recreate: "Create a new code", copy: "Copy code", copied: "Code copied", orJoin: "Or paste a code created on the other computer", connect: "Connect", connected: "Computers linked", mapped: "In your context this is", needContext: "First choose a base chat and wait for people to be identified.", openContext: "Open context", topics: "TOPICS FOR THIS PAIR", topicTitle: "What the agents will discuss", topicHint: "Approved topics from both computers gather here. Each title includes a short note on what happened and what the conversation should clarify.", localPreview: "These are the approved topics from your chat. Topics from your partner's computer will be added after connection.", noTopics: "No approved topics for the selected person yet.", addTopic: "What happened, and what do you want to understand?", discuss: "Discuss all topics", discussing: "Agents are discussing topics…", analysis: "PEOPLE AND TOPICS", analysisTitle: "Prepared from the base chat", analyzing: "Codex is identifying people and preparing topic drafts…", noAnalysis: "People and topic drafts will appear here after export.", people: "People in context", about: "About", with: "Discuss with", approve: "Allow discussion", cross: "This topic is about someone else — verify the recipient carefully.", unclear: "The recipient is uncertain — verify before allowing." },
    cs: { connection: "PROPOJENÍ", link: "Propojit dva počítače", who: "Komu ve vašem kontextu patří druhý počítač?", choosePerson: "Vyberte osobu", create: "Vytvořit pozvánku", recreate: "Vytvořit nový kód", copy: "Kopírovat kód", copied: "Kód zkopírován", orJoin: "Nebo vložte kód vytvořený na druhém počítači", connect: "Připojit", connected: "Počítače jsou propojeny", mapped: "Ve vašem kontextu je to", needContext: "Nejprve vyberte základní chat a počkejte na určení osob.", openContext: "Otevřít kontext", topics: "TÉMATA PRO TUTO DVOJICI", topicTitle: "O čem budou agenti mluvit", topicHint: "Schválená témata z obou počítačů se shromažďují zde. Pod názvem je stručně uvedeno, co se stalo a co má rozhovor objasnit.", localPreview: "Zatím jsou zobrazená schválená témata z vašeho chatu. Po propojení se přidají témata z počítače partnera.", noTopics: "Pro vybranou osobu zatím nejsou schválená témata.", addTopic: "Co se stalo a čemu chcete porozumět?", discuss: "Probrat všechna témata", discussing: "Agenti probírají témata…", analysis: "LIDÉ A TÉMATA", analysisTitle: "Připraveno ze základního chatu", analyzing: "Codex rozpoznává osoby a připravuje návrhy témat…", noAnalysis: "Po exportu se zde zobrazí lidé a návrhy témat.", people: "Lidé v kontextu", about: "O kom", with: "Probrat s", approve: "Povolit diskusi", cross: "Téma je o jiné osobě — pečlivě ověřte adresáta.", unclear: "Adresát je nejistý — před povolením jej ověřte." },
    fr: { connection: "CONNEXION", link: "Relier deux ordinateurs", who: "À quelle personne de votre contexte correspond l’autre ordinateur ?", choosePerson: "Choisir une personne", create: "Créer une invitation", recreate: "Créer un nouveau code", copy: "Copier le code", copied: "Code copié", orJoin: "Ou collez un code créé sur l’autre ordinateur", connect: "Connecter", connected: "Ordinateurs reliés", mapped: "Dans votre contexte, il s’agit de", needContext: "Choisissez d’abord un chat de base et attendez l’identification des personnes.", openContext: "Ouvrir le contexte", topics: "SUJETS POUR CETTE PAIRE", topicTitle: "Ce que les agents vont discuter", topicHint: "Les sujets approuvés des deux ordinateurs sont réunis ici. Sous chaque titre, une note précise ce qui s’est passé et ce que la conversation doit éclaircir.", localPreview: "Voici les sujets autorisés de votre chat. Ceux de l'ordinateur de votre partenaire seront ajoutés après la connexion.", noTopics: "Aucun sujet autorisé pour la personne sélectionnée.", addTopic: "Que s’est-il passé et que voulez-vous comprendre ?", discuss: "Discuter tous les sujets", discussing: "Les agents discutent…", analysis: "PERSONNES ET SUJETS", analysisTitle: "Préparé à partir du chat de base", analyzing: "Codex identifie les personnes et prépare les sujets…", noAnalysis: "Les personnes et sujets apparaîtront ici après l’export.", people: "Personnes du contexte", about: "À propos de", with: "Discuter avec", approve: "Autoriser la discussion", cross: "Ce sujet concerne une autre personne — vérifiez soigneusement le destinataire.", unclear: "Le destinataire est incertain — vérifiez avant d’autoriser." },
  }[language];
  const pairListText = {
    ru: { more: "Показать ещё", less: "Свернуть список" },
    en: { more: "Show more", less: "Collapse list" },
    cs: { more: "Zobrazit další", less: "Sbalit seznam" },
    fr: { more: "Afficher plus", less: "Réduire la liste" },
  }[language];
  const compatibilityText = {
    ru: "На втором компьютере нужно обновить Family Bridge. После обновления разговор начнётся автоматически.",
    en: "Family Bridge needs an update on the other computer. The conversation will start automatically afterwards.",
    cs: "Na druhém počítači je třeba aktualizovat Family Bridge. Poté rozhovor začne automaticky.",
    fr: "Family Bridge doit être mis à jour sur l’autre ordinateur. La conversation démarrera ensuite automatiquement.",
  }[language];
  const pairVersionText = {
    ru: { local: "Это приложение", peer: "Приложение собеседника", current: "Обновлено", updateNeeded: "Есть обновление", unknown: "Связь ещё не подтверждена", check: "Проверить обновления", checking: "Проверяем обновления…" },
    en: { local: "This computer", peer: "Partner's computer", current: "Up to date", updateNeeded: "Update needed", unknown: "Version not received yet", check: "Check for updates", checking: "Checking for updates…" },
    cs: { local: "Tento počítač", peer: "Počítač partnera", current: "Aktuální", updateNeeded: "Je třeba aktualizovat", unknown: "Verze zatím nebyla přijata", check: "Zkontrolovat aktualizace", checking: "Kontrola aktualizací…" },
    fr: { local: "Cet ordinateur", peer: "Ordinateur du partenaire", current: "À jour", updateNeeded: "Mise à jour requise", unknown: "Version pas encore reçue", check: "Vérifier les mises à jour", checking: "Vérification des mises à jour…" },
  }[language];
  const onboardingText = {
    ru: { eyebrow: "ПЕРВЫЙ ЗАПУСК", title: "Подготовим первый разговор", lead: "Расскажите приложению о ситуации в уже существующем или новом разговоре с помощником. Исходные сообщения останутся на этом компьютере.", chooseTitle: "1. Выберите исходный разговор", chooseHint: "Откроем ваши проекты и разговоры ChatGPT.", confirmHint: "Этот разговор уже использовался. Можно продолжить с ним или выбрать другой.", useSaved: "Продолжить с этим разговором", processingTitle: "Разбираемся в ситуации", resumeTitle: "Добавляем новые сообщения", export: "Сохраняем ваши сообщения", people: "Находим важных людей", topics: "Предлагаем темы для разговора", finalizing: "Завершаем подготовку", waiting: "Это может занять несколько минут. Можно перейти в другой раздел.", resumeWaiting: "Найденные люди и темы сохранены. Добавляем только новые сообщения.", reviewTitle: "Выберите темы", reviewHint: "Сначала выберите человека. У каждой темы показаны ситуация, цель и возможное начало. Без вашего выбора ничего не отправится.", finish: "Сохранить выбранные темы", noPeople: "Пока не удалось найти людей. Проверьте новые сообщения или выберите другой разговор." },
    en: { eyebrow: "FIRST RUN", title: "First, prepare your context", lead: "Choose one chat as your agent's private foundation. Raw messages remain on this computer.", chooseTitle: "1. Choose a base chat", chooseHint: "We'll open your Codex projects and chats.", confirmHint: "This chat was selected before. Use it again or choose another.", useSaved: "Use this chat", processingTitle: "Preparing context", resumeTitle: "Updating your saved context", export: "Reading your messages", people: "Identifying people", topics: "Preparing possible conversations", finalizing: "Assembling recommendations", waiting: "This can take a few minutes. You may leave the app open.", resumeWaiting: "Existing people and topics are preserved. Only changes from the chat are being added.", reviewTitle: "Choose conversations", reviewHint: "Choose a person first. Each topic shows the situation, the goal, and a possible opening. Nothing is shared without your approval.", finish: "Prepare selected conversations", noPeople: "No people were identified. Refresh the export or choose another chat." },
    cs: { eyebrow: "PRVNÍ SPUŠTĚNÍ", title: "Nejprve připravíme váš kontext", lead: "Vyberte jeden chat jako soukromý základ agenta. Původní zprávy zůstanou v tomto počítači.", chooseTitle: "1. Vyberte základní chat", chooseHint: "Otevřeme seznam vašich projektů a chatů Codex.", confirmHint: "Tento chat už byl vybrán. Můžete jej použít znovu nebo zvolit jiný.", useSaved: "Použít tento chat", processingTitle: "Připravujeme kontext", resumeTitle: "Doplňujeme uložený kontext", export: "Načítáme vaše zprávy", people: "Rozpoznáváme osoby", topics: "Připravujeme možné rozhovory", finalizing: "Sestavujeme doporučení", waiting: "Může to trvat několik minut. Aplikaci můžete nechat otevřenou.", resumeWaiting: "Nalezené osoby a témata zůstávají zachována. Přidáváme jen změny z chatu.", reviewTitle: "Vyberte rozhovory", reviewHint: "Nejprve vyberte osobu. U každého tématu uvidíte situaci, cíl a možný začátek. Bez vašeho svolení se nic nesdílí.", finish: "Připravit vybrané rozhovory", noPeople: "Nebyly rozpoznány žádné osoby. Obnovte export nebo vyberte jiný chat." },
    fr: { eyebrow: "PREMIER DÉMARRAGE", title: "Préparons d'abord votre contexte", lead: "Choisissez un chat comme base privée de votre agent. Les messages bruts restent sur cet ordinateur.", chooseTitle: "1. Choisissez un chat de base", chooseHint: "Nous ouvrirons vos projets et chats Codex.", confirmHint: "Ce chat a déjà été choisi. Vous pouvez le réutiliser ou en choisir un autre.", useSaved: "Utiliser ce chat", processingTitle: "Préparation du contexte", resumeTitle: "Mise à jour du contexte enregistré", export: "Lecture de vos messages", people: "Identification des personnes", topics: "Préparation des conversations possibles", finalizing: "Assemblage des recommandations", waiting: "Cela peut prendre quelques minutes. Vous pouvez laisser l'application ouverte.", resumeWaiting: "Les personnes et sujets existants sont conservés. Seuls les changements du chat sont ajoutés.", reviewTitle: "Choisissez les conversations", reviewHint: "Choisissez d’abord une personne. Chaque sujet affiche la situation, l’objectif et une ouverture possible. Rien n'est partagé sans votre accord.", finish: "Préparer les conversations choisies", noPeople: "Aucune personne n'a été identifiée. Actualisez l'export ou choisissez un autre chat." },
  }[language];
  const setupText = {
    ru: { chooseTitle: "Как будет работать ваш помощник?", chooseBody: "Используйте свой ChatGPT на этом компьютере или подключитесь к доверенному помощнику. Этот выбор можно изменить позже.", localTitle: "На этом компьютере", localBody: "Ваш ChatGPT и ваша личная история.", trustedTitle: "Через доверенного помощника", trustedBody: "Подходит без платного аккаунта. Владелец помощника сможет видеть текст при обработке.", ready: "Вход в ChatGPT подтверждён", signInNeeded: "Нужно войти в ChatGPT.", runtimeMissing: "Компонент ChatGPT не найден. Переустановите Family Bridge — он добавляется автоматически.", signIn: "Войти в ChatGPT", checkSignIn: "Проверить вход", signInOpened: "Вход открыт в браузере. После завершения нажмите «Проверить вход».", sourceChoice: "Можно использовать существующий разговор с психологом или начать новый — помощник будет задавать вопросы по одному.", newConversation: "Начать новый разговор", retryConversation: "Повторить начало разговора", trustedRejected: "Подключение не разрешено. Можно отправить запрос ещё раз.", trustedOffline: "Доверенный помощник сейчас офлайн. Запрос сохранён и проверяется автоматически.", trustedPending: "Запрос сохранён. Подключение завершится автоматически, когда доверенный помощник будет доступен.", retryRequest: "Отправить запрос снова", firstConversation: "Первый разговор с психологом", firstConversationBody: "Для вас будет создан отдельный постоянный разговор. Его история не смешивается с историями других людей.", startConversation: "Начать разговор", intakeTitle: "Разговор с психологом", you: "Вы", psychologist: "Психолог", placeholder: "Расскажите своими словами…", waitingReply: "Ждём ответ…", retrySend: "Повторить отправку", send: "Отправить", finishSaving: "Завершить подготовку", preparePeople: "Найти людей и темы", durable: "Сообщение сохраняется на этом компьютере до отправки. Ctrl+Enter — отправить." },
    en: { chooseTitle: "How should your assistant work?", chooseBody: "Use your ChatGPT on this computer or connect to a trusted assistant. You can change this later.", localTitle: "On this computer", localBody: "Your ChatGPT and your personal history.", trustedTitle: "Through a trusted assistant", trustedBody: "Works without a paid account. The assistant’s owner can see text while it is processed.", ready: "ChatGPT sign-in confirmed", signInNeeded: "Sign in to ChatGPT.", runtimeMissing: "The ChatGPT component was not found. Reinstall Family Bridge; it is included automatically.", signIn: "Sign in to ChatGPT", checkSignIn: "Check sign-in", signInOpened: "Sign-in opened in your browser. When finished, select “Check sign-in”.", sourceChoice: "Use an existing conversation with a psychologist or start a new one. The assistant will ask one question at a time.", newConversation: "Start a new conversation", retryConversation: "Retry starting conversation", trustedRejected: "The connection was not approved. You can send the request again.", trustedOffline: "The trusted assistant is offline. Your request is saved and checked automatically.", trustedPending: "Your request is saved. Connection will complete automatically when the trusted assistant is available.", retryRequest: "Send request again", firstConversation: "First conversation with a psychologist", firstConversationBody: "A separate, persistent conversation will be created for you. Its history is not mixed with anyone else’s.", startConversation: "Start conversation", intakeTitle: "Conversation with a psychologist", you: "You", psychologist: "Psychologist", placeholder: "Describe it in your own words…", waitingReply: "Waiting for a reply…", retrySend: "Retry sending", send: "Send", finishSaving: "Finish preparation", preparePeople: "Find people and topics", durable: "Your message is saved on this computer before sending. Ctrl+Enter to send." },
    cs: { chooseTitle: "Jak má váš pomocník pracovat?", chooseBody: "Použijte svůj ChatGPT v tomto počítači nebo důvěryhodného pomocníka. Volbu lze později změnit.", localTitle: "Na tomto počítači", localBody: "Váš ChatGPT a vaše osobní historie.", trustedTitle: "Přes důvěryhodného pomocníka", trustedBody: "Funguje bez placeného účtu. Vlastník pomocníka může při zpracování vidět text.", ready: "Přihlášení k ChatGPT potvrzeno", signInNeeded: "Je třeba se přihlásit k ChatGPT.", runtimeMissing: "Součást ChatGPT nebyla nalezena. Přeinstalujte Family Bridge; přidává se automaticky.", signIn: "Přihlásit se k ChatGPT", checkSignIn: "Ověřit přihlášení", signInOpened: "Přihlášení se otevřelo v prohlížeči. Po dokončení zvolte „Ověřit přihlášení“.", sourceChoice: "Použijte existující rozhovor s psychologem, nebo začněte nový. Pomocník bude klást otázky postupně.", newConversation: "Začít nový rozhovor", retryConversation: "Zopakovat zahájení", trustedRejected: "Připojení nebylo schváleno. Požadavek lze odeslat znovu.", trustedOffline: "Důvěryhodný pomocník je offline. Požadavek je uložený a kontroluje se automaticky.", trustedPending: "Požadavek je uložený. Připojení se dokončí automaticky, až bude pomocník dostupný.", retryRequest: "Odeslat požadavek znovu", firstConversation: "První rozhovor s psychologem", firstConversationBody: "Vznikne pro vás samostatný trvalý rozhovor. Jeho historie se nemíchá s historií jiných lidí.", startConversation: "Začít rozhovor", intakeTitle: "Rozhovor s psychologem", you: "Vy", psychologist: "Psycholog", placeholder: "Popište situaci vlastními slovy…", waitingReply: "Čekáme na odpověď…", retrySend: "Odeslat znovu", send: "Odeslat", finishSaving: "Dokončit přípravu", preparePeople: "Najít osoby a témata", durable: "Zpráva se před odesláním uloží v tomto počítači. Ctrl+Enter odešle." },
    fr: { chooseTitle: "Comment votre assistant doit-il fonctionner ?", chooseBody: "Utilisez votre ChatGPT sur cet ordinateur ou un assistant de confiance. Ce choix pourra être modifié.", localTitle: "Sur cet ordinateur", localBody: "Votre ChatGPT et votre historique personnel.", trustedTitle: "Avec un assistant de confiance", trustedBody: "Fonctionne sans compte payant. Le propriétaire de l’assistant peut voir le texte pendant le traitement.", ready: "Connexion à ChatGPT confirmée", signInNeeded: "Connectez-vous à ChatGPT.", runtimeMissing: "Le composant ChatGPT est introuvable. Réinstallez Family Bridge ; il est ajouté automatiquement.", signIn: "Se connecter à ChatGPT", checkSignIn: "Vérifier la connexion", signInOpened: "La connexion est ouverte dans le navigateur. Une fois terminée, choisissez « Vérifier la connexion ».", sourceChoice: "Utilisez une conversation existante avec un psychologue ou commencez-en une nouvelle. L’assistant posera une question à la fois.", newConversation: "Commencer une nouvelle conversation", retryConversation: "Réessayer de commencer", trustedRejected: "La connexion n’a pas été autorisée. Vous pouvez renvoyer la demande.", trustedOffline: "L’assistant de confiance est hors ligne. La demande est enregistrée et vérifiée automatiquement.", trustedPending: "Votre demande est enregistrée. La connexion se terminera automatiquement lorsque l’assistant sera disponible.", retryRequest: "Renvoyer la demande", firstConversation: "Première conversation avec un psychologue", firstConversationBody: "Une conversation permanente et séparée sera créée pour vous. Son historique ne se mélange pas à celui d’autres personnes.", startConversation: "Commencer la conversation", intakeTitle: "Conversation avec un psychologue", you: "Vous", psychologist: "Psychologue", placeholder: "Décrivez la situation avec vos propres mots…", waitingReply: "En attente d’une réponse…", retrySend: "Réessayer l’envoi", send: "Envoyer", finishSaving: "Terminer la préparation", preparePeople: "Trouver les personnes et sujets", durable: "Votre message est enregistré sur cet ordinateur avant l’envoi. Ctrl+Entrée pour envoyer." },
  }[language];
  const settingsText = {
    ru: { model: "Модель помощника", automatic: "Автоматически для моего аккаунта", effort: "Глубина ответа", saved: "Изменения применятся к следующим ответам и сохранятся на этом компьютере.", trusted: "Доверенный помощник", trustedInfo: "При передаче сообщения зашифрованы. Для ответа доверенный помощник расшифровывает их и передаёт в ChatGPT; владелец этого компьютера может видеть текст.", off: "Не использовать", host: "Помогать другим", client: "Использовать доверенного помощника", newConnections: "Новые подключения", accept: "Принимать автоматически", ask: "Спрашивать", reject: "Не принимать", request: "Запрос", allow: "Разрешить", deny: "Отклонить", connected: "на связи", offline: "офлайн", disabled: "отключён", disconnect: "Отключить", status: "Статус", pendingApproval: "ожидает разрешения", pending: "сообщений ожидает", offlineNormal: "Офлайн — нормальное состояние: сообщения сохраняются и отправятся автоматически.", autoStart: "Запускать Family Bridge вместе с компьютером" },
    en: { model: "Assistant model", automatic: "Automatic for my account", effort: "Response depth", saved: "Changes apply to new replies and are saved on this computer.", trusted: "Trusted assistant", trustedInfo: "Messages are encrypted in transit. To answer, the trusted assistant decrypts them and sends them to ChatGPT; the computer’s owner may see the text.", off: "Do not use", host: "Help others", client: "Use a trusted assistant", newConnections: "New connections", accept: "Accept automatically", ask: "Ask me", reject: "Do not accept", request: "Request", allow: "Allow", deny: "Deny", connected: "connected", offline: "offline", disabled: "disabled", disconnect: "Disconnect", status: "Status", pendingApproval: "waiting for approval", pending: "messages waiting", offlineNormal: "Offline is normal: messages are saved and will be sent automatically.", autoStart: "Start Family Bridge with the computer" },
    cs: { model: "Model pomocníka", automatic: "Automaticky pro můj účet", effort: "Hloubka odpovědi", saved: "Změny se použijí na nové odpovědi a uloží se v tomto počítači.", trusted: "Důvěryhodný pomocník", trustedInfo: "Při přenosu jsou zprávy šifrované. Důvěryhodný pomocník je pro odpověď dešifruje a předá ChatGPT; vlastník počítače může text vidět.", off: "Nepoužívat", host: "Pomáhat ostatním", client: "Použít důvěryhodného pomocníka", newConnections: "Nová připojení", accept: "Přijímat automaticky", ask: "Zeptat se", reject: "Nepřijímat", request: "Požadavek", allow: "Povolit", deny: "Odmítnout", connected: "připojeno", offline: "offline", disabled: "vypnuto", disconnect: "Odpojit", status: "Stav", pendingApproval: "čeká na schválení", pending: "čekajících zpráv", offlineNormal: "Offline je normální stav: zprávy se uloží a odešlou automaticky.", autoStart: "Spouštět Family Bridge s počítačem" },
    fr: { model: "Modèle de l’assistant", automatic: "Automatique pour mon compte", effort: "Profondeur de réponse", saved: "Les changements s’appliquent aux nouvelles réponses et sont enregistrés sur cet ordinateur.", trusted: "Assistant de confiance", trustedInfo: "Les messages sont chiffrés pendant le transfert. Pour répondre, l’assistant les déchiffre et les transmet à ChatGPT ; le propriétaire de l’ordinateur peut voir le texte.", off: "Ne pas utiliser", host: "Aider d’autres personnes", client: "Utiliser un assistant de confiance", newConnections: "Nouvelles connexions", accept: "Accepter automatiquement", ask: "Me demander", reject: "Ne pas accepter", request: "Demande", allow: "Autoriser", deny: "Refuser", connected: "connecté", offline: "hors ligne", disabled: "désactivé", disconnect: "Déconnecter", status: "État", pendingApproval: "en attente d’autorisation", pending: "messages en attente", offlineNormal: "Le mode hors ligne est normal : les messages sont enregistrés puis envoyés automatiquement.", autoStart: "Lancer Family Bridge avec l’ordinateur" },
  }[language];
  const effortNames: Record<CodexReasoningEffort, Record<Language, string>> = {
    low: { ru: "Небольшая", en: "Low", cs: "Nízká", fr: "Faible" },
    medium: { ru: "Обычная", en: "Standard", cs: "Běžná", fr: "Standard" },
    high: { ru: "Глубокая", en: "Deep", cs: "Hluboká", fr: "Approfondie" },
    xhigh: { ru: "Очень глубокая", en: "Very deep", cs: "Velmi hluboká", fr: "Très approfondie" },
    max: { ru: "Максимальная", en: "Maximum", cs: "Maximální", fr: "Maximale" },
    ultra: { ru: "Предельная", en: "Ultra", cs: "Nejvyšší", fr: "Ultime" },
  };
  const suggestionText = {
    ru: { hint: 'Здесь только ещё не начатые темы. Начатые и завершённые — в «Разговорах».', removed: 'Убранные', remove: 'Не обсуждать', restore: 'Вернуть в предложения' },
    en: { hint: 'Only topics not started yet. Started and completed topics are in Conversations.', removed: 'Removed', remove: 'Do not discuss', restore: 'Restore suggestion' },
    cs: { hint: 'Zde jsou jen dosud nezahájená témata. Zahájená a dokončená najdete v Rozhovorech.', removed: 'Odebraná', remove: 'Neprobírat', restore: 'Vrátit do návrhů' },
    fr: { hint: 'Ici, uniquement les sujets non commencés. Les autres se trouvent dans Conversations.', removed: 'Retirés', remove: 'Ne pas discuter', restore: 'Rétablir la suggestion' },
  }[language];
  const registryText = {
    ru: { topicsFor: "Разговоры с", needReview: "нужно проверить", all: "Все", review: "Проверить", approved: "Выбраны", allowedOf: "выбрано из", allowSafe: "Выбрать безопасные", search: "Найти разговор", collapse: "Свернуть", expand: "Показать подробности", noFilteredTopics: "В этом фильтре тем нет.", context: "О чём речь", goal: "Что хочется понять", opening: "Как может начаться разговор", more: "Показать остальные", less: "Свернуть список", refine: "Уточнить тему", topicLabel: "Название разговора", save: "Сохранить уточнение", retry: "Попробовать ещё раз", cancel: "Отмена", editHint: "Сохранение не отправляет тему. Для передачи её нужно отдельно выбрать галочкой.", selectedHint: "Тема уже выбрана. Снимите выбор, чтобы уточнить её.", instruction: "Что здесь непонятно или какого контекста не хватает?", instructionPlaceholder: "Расскажите агенту, о чём на самом деле речь, или попросите объяснить тему яснее", prepare: "Уточнить тему", preparing: "Агент уточняет тему…", preview: "Теперь тема будет выглядеть так", previewHint: "Это точный текст для передачи. Ваше пояснение останется только у вашего агента.", prepared: "Тема уточнена" },
    en: { topicsFor: "Conversations with", needReview: "need review", all: "All", review: "Review", approved: "Selected", allowedOf: "selected of", allowSafe: "Select safe topics", search: "Find a conversation", collapse: "Collapse", expand: "Show details", noFilteredTopics: "No topics match this filter.", context: "What this is about", goal: "What to understand", opening: "How the conversation may start", more: "Show the rest", less: "Collapse list", refine: "Clarify topic", topicLabel: "Conversation title", save: "Save clarification", retry: "Try again", cancel: "Cancel", editHint: "Saving does not share the topic. Select it separately to share it.", selectedHint: "This topic is already selected. Deselect it before clarifying it.", instruction: "What is unclear or what context is missing?", instructionPlaceholder: "Tell your agent what this is really about, or ask it to explain the topic more clearly", prepare: "Clarify topic", preparing: "Your agent is clarifying the topic…", preview: "The topic will now look like this", previewHint: "This is the exact text to be shared. Your explanation stays with your agent.", prepared: "Topic clarified" },
    cs: { topicsFor: "Rozhovory s", needReview: "je třeba zkontrolovat", all: "Vše", review: "Zkontrolovat", approved: "Vybráno", allowedOf: "vybráno z", allowSafe: "Vybrat bezpečná témata", search: "Najít rozhovor", collapse: "Sbalit", expand: "Zobrazit podrobnosti", noFilteredTopics: "Tomuto filtru neodpovídají žádná témata.", context: "O čem to je", goal: "Čemu porozumět", opening: "Jak může rozhovor začít", more: "Zobrazit ostatní", less: "Sbalit seznam", refine: "Upřesnit téma", topicLabel: "Název rozhovoru", save: "Uložit upřesnění", retry: "Zkusit znovu", cancel: "Zrušit", editHint: "Uložení téma neodešle. Pro sdílení ho poté vyberte zvlášť.", selectedHint: "Téma je již vybráno. Před upřesněním výběr zrušte.", instruction: "Co je nejasné nebo jaký kontext chybí?", instructionPlaceholder: "Vysvětlete agentovi, o co skutečně jde, nebo ho požádejte o jasnější popis", prepare: "Upřesnit téma", preparing: "Váš agent upřesňuje téma…", preview: "Téma bude nyní vypadat takto", previewHint: "Toto je přesný text ke sdílení. Vaše vysvětlení zůstane jen u vašeho agenta.", prepared: "Téma je upřesněno" },
    fr: { topicsFor: "Conversations avec", needReview: "à vérifier", all: "Tous", review: "Vérifier", approved: "Choisies", allowedOf: "choisies sur", allowSafe: "Choisir les sujets sûrs", search: "Rechercher une conversation", collapse: "Réduire", expand: "Afficher les détails", noFilteredTopics: "Aucun sujet ne correspond à ce filtre.", context: "De quoi s’agit-il", goal: "Ce qu’il faut comprendre", opening: "Comment la conversation peut commencer", more: "Afficher les autres", less: "Réduire la liste", refine: "Clarifier le sujet", topicLabel: "Titre de la conversation", save: "Enregistrer la clarification", retry: "Réessayer", cancel: "Annuler", editHint: "L’enregistrement ne partage pas le sujet. Sélectionnez-le ensuite séparément.", selectedHint: "Ce sujet est déjà sélectionné. Désélectionnez-le avant de le clarifier.", instruction: "Qu’est-ce qui n’est pas clair ou quel contexte manque ?", instructionPlaceholder: "Expliquez à votre agent de quoi il s’agit réellement ou demandez-lui de rendre le sujet plus clair", prepare: "Clarifier le sujet", preparing: "Votre agent clarifie le sujet…", preview: "Le sujet se présentera maintenant ainsi", previewHint: "C’est le texte exact à partager. Votre explication reste uniquement avec votre agent.", prepared: "Sujet clarifié" },
  }[language];
  const navigationText = {
    ru: { start: "Начало работы", connection: "Связь и темы", context: "Исходный разговор", people: "Что знает помощник", reports: "Разговоры", settings: "Настройки", setupTitle: "Подготовка первого разговора", connectionTitle: "Связь и темы", contextTitle: "Исходный разговор и темы", peopleTitle: "Что знает помощник", reportsTitle: "Разговоры", settingsTitle: "Настройки" },
    en: { start: "First run", connection: "Connection", context: "Source chat and topics", people: "What my agent knows", reports: "Conversations", settings: "Settings", setupTitle: "Prepare the first conversation", connectionTitle: "Connection and topics", contextTitle: "Source chat and topics", peopleTitle: "What my agent knows", reportsTitle: "Conversations", settingsTitle: "Settings" },
    cs: { start: "První spuštění", connection: "Propojení", context: "Zdrojový chat a témata", people: "Co můj agent ví", reports: "Rozhovory", settings: "Nastavení", setupTitle: "Příprava prvního rozhovoru", connectionTitle: "Propojení a témata", contextTitle: "Zdrojový chat a témata", peopleTitle: "Co můj agent ví", reportsTitle: "Rozhovory", settingsTitle: "Nastavení" },
    fr: { start: "Premier démarrage", connection: "Connexion", context: "Chat source et sujets", people: "Ce que sait mon agent", reports: "Conversations", settings: "Paramètres", setupTitle: "Préparer la première conversation", connectionTitle: "Connexion et sujets", contextTitle: "Chat source et sujets", peopleTitle: "Ce que sait mon agent", reportsTitle: "Conversations", settingsTitle: "Paramètres" },
  }[language];
  const portraitText = {
    ru: { eyebrow: "ВАЖНЫЕ ЛЮДИ", title: "Как помощник понимает ситуацию", hint: "Эти заметки собраны из исходного разговора и уточняются после новых бесед. Их можно исправить или удалить.", you: "Вы", empty: "Пока информации недостаточно.", updating: "Добавляем то, что стало понятно из разговора…", sourceChat: "Из исходного разговора", sourceConversation: "Из разговора помощников", edit: "Исправить", remove: "Удалить", save: "Сохранить", cancel: "Отмена", removeConfirm: "Удалить эту заметку?", kinds: { fact: "Факт", view: "Мнение", preference: "Желание или граница", pattern: "Повторяющаяся реакция", uncertainty: "Пока неясно" } },
    en: { eyebrow: "PEOPLE PORTRAITS", title: "How the agent understands people", hint: "Portraits come from the source chat and are refined after completed agent conversations.", you: "You", empty: "There is not enough information about this person yet.", updating: "Updating portraits from the completed conversation…", sourceChat: "From the source chat", sourceConversation: "From conversation", edit: "Edit", remove: "Delete", save: "Save", cancel: "Cancel", removeConfirm: "Delete this observation from the portrait?", kinds: { fact: "Fact", view: "View", preference: "Preference or boundary", pattern: "Recurring response", uncertainty: "Uncertainty" } },
    cs: { eyebrow: "PORTRÉTY LIDÍ", title: "Jak agent chápe lidi", hint: "Portréty vznikají ze zdrojového chatu a upřesňují se po dokončených rozhovorech agentů.", you: "Vy", empty: "O této osobě zatím není dost informací.", updating: "Doplňujeme portréty z dokončeného rozhovoru…", sourceChat: "Ze zdrojového chatu", sourceConversation: "Z rozhovoru", edit: "Upravit", remove: "Smazat", save: "Uložit", cancel: "Zrušit", removeConfirm: "Smazat toto pozorování z portrétu?", kinds: { fact: "Fakt", view: "Postoj", preference: "Preference nebo hranice", pattern: "Opakovaná reakce", uncertainty: "Nejistota" } },
    fr: { eyebrow: "PORTRAITS", title: "Comment l’agent comprend les personnes", hint: "Les portraits viennent du chat source et sont affinés après les conversations terminées.", you: "Vous", empty: "Il n’y a pas encore assez d’informations sur cette personne.", updating: "Mise à jour des portraits après la conversation…", sourceChat: "Du chat source", sourceConversation: "De la conversation", edit: "Modifier", remove: "Supprimer", save: "Enregistrer", cancel: "Annuler", removeConfirm: "Supprimer cette observation du portrait ?", kinds: { fact: "Fait", view: "Position", preference: "Préférence ou limite", pattern: "Réaction récurrente", uncertainty: "Incertitude" } },
  }[language];
  const ownerQuestionText = {
    ru: { eyebrow: "НУЖЕН ВАШ ОТВЕТ", title: "Агент не хочет додумывать", paused: "Разговор поставлен на паузу", privacy: "Ответ сначала получит только ваш агент. Второму агенту уйдёт лишь аккуратный вывод своими словами.", placeholder: "Ваш ответ", answer: "Ответить и продолжить", unknown: "Не знаю", decline: "Не хочу отвечать", processing: "Продолжаем разговор…" },
    en: { eyebrow: "YOUR ANSWER IS NEEDED", title: "The agent does not want to guess", paused: "The conversation is paused", privacy: "Only your agent receives the raw answer. The other agent receives a careful paraphrased conclusion.", placeholder: "Your answer", answer: "Answer and continue", unknown: "I don't know", decline: "I don't want to answer", processing: "Continuing the conversation…" },
    cs: { eyebrow: "JE POTŘEBA VAŠE ODPOVĚĎ", title: "Agent nechce hádat", paused: "Rozhovor je pozastaven", privacy: "Původní odpověď obdrží pouze váš agent. Druhý agent dostane jen opatrně formulovaný závěr.", placeholder: "Vaše odpověď", answer: "Odpovědět a pokračovat", unknown: "Nevím", decline: "Nechci odpovědět", processing: "Pokračujeme v rozhovoru…" },
    fr: { eyebrow: "VOTRE RÉPONSE EST NÉCESSAIRE", title: "L’agent ne veut pas deviner", paused: "La conversation est en pause", privacy: "Seul votre agent reçoit la réponse brute. L’autre agent reçoit uniquement une conclusion reformulée avec précaution.", placeholder: "Votre réponse", answer: "Répondre et continuer", unknown: "Je ne sais pas", decline: "Je ne veux pas répondre", processing: "Reprise de la conversation…" },
  }[language];
  const contextRefreshText = {
    ru: { title: "Ваш контекст на месте", body: "Проверяем, появились ли в выбранном чате новые сообщения. Уже найденные люди и темы не сбрасываются." },
    en: { title: "Your context is still here", body: "Checking the selected chat for new messages. Existing people and topics are not being reset." },
    cs: { title: "Váš kontext zůstává zachován", body: "Kontrolujeme nové zprávy ve vybraném chatu. Již nalezené osoby a témata se nemažou." },
    fr: { title: "Votre contexte est toujours là", body: "Nous vérifions les nouveaux messages du chat sélectionné. Les personnes et sujets déjà trouvés ne sont pas réinitialisés." },
  }[language];
  const topicStatusText = {
    ru: { selected: "Выбрано", pending: "Начнётся автоматически", active: "Разговор идёт", complete: "Итог готов", question: "Нужен ваш ответ" },
    en: { selected: "Not queued", pending: "Waiting to start", active: "In discussion", complete: "Result ready", question: "Your answer is needed" },
    cs: { selected: "Není ve frontě", pending: "Čeká na spuštění", active: "Probíhá rozhovor", complete: "Výsledek je připraven", question: "Potřebujeme vaši odpověď" },
    fr: { selected: "Pas en file d’attente", pending: "En attente de lancement", active: "Discussion en cours", complete: "Bilan prêt", question: "Votre réponse est nécessaire" },
  }[language];
  const reportsText = {
    ru: { empty: "Завершённые разговоры появятся здесь автоматически.", files: "Открыть резервные копии", messages: "реплик", answer: "Возможная реплика —", conversation: "Прочитать весь разговор", proposed: "Кто предложил тему", comparison: "Что стало понятно", unfinished: "Разговор остановился до итога. Добавьте уточнение, чтобы продолжить." },
    en: { empty: "Completed answers will appear here automatically.", files: "Show files in folder", messages: "messages", answer: "Likely words —", conversation: "Read the full conversation", proposed: "Topic proposed by", comparison: "Where you agree or differ", unfinished: "The conversation stopped without a natural ending. You can continue it with your own follow-up." },
    cs: { empty: "Hotové odpovědi se zde objeví automaticky.", files: "Zobrazit soubory ve složce", messages: "zpráv", answer: "Předpokládaná věta —", conversation: "Přečíst celý rozhovor", proposed: "Téma navrhli", comparison: "V čem se shodujete nebo lišíte", unfinished: "Rozhovor se zastavil bez přirozeného zakončení. Můžete v něm pokračovat vlastním upřesněním." },
    fr: { empty: "Les réponses terminées apparaîtront ici automatiquement.", files: "Afficher les fichiers dans le dossier", messages: "messages", answer: "Paroles probables —", conversation: "Lire toute la conversation", proposed: "Sujet proposé par", comparison: "Vos accords ou désaccords", unfinished: "La conversation s’est arrêtée sans conclusion naturelle. Vous pouvez la poursuivre avec votre propre précision." },
  }[language];
  const dialogueText = {
    ru: { conversation: "Разговор", completed: "Завершён", unfinished: "Нужно продолжить", result: "К чему пришли", positions: "Коротко о позициях" },
    en: { conversation: "Conversation", completed: "Completed", unfinished: "Needs a follow-up", result: "Where you landed", positions: "Positions in brief" },
    cs: { conversation: "Rozhovor", completed: "Dokončen", unfinished: "Je třeba pokračovat", result: "K čemu jste dospěli", positions: "Stručně o postojích" },
    fr: { conversation: "Conversation", completed: "Terminée", unfinished: "À poursuivre", result: "Votre conclusion", positions: "Positions en bref" },
  }[language];
  const sourceText = {
    ru: { local: `Предложено: ${state.displayName || "этот компьютер"}`, peer: `Предложено: ${state.remote.peerName || "партнёр"}`, both: "Предложили оба", unknown: "Добавлена раньше" },
    en: { local: `Topic from ${state.displayName || "this computer"}`, peer: `Topic from ${state.remote.peerName || "partner"}`, both: "Proposed by both", unknown: "Added earlier" },
    cs: { local: `Téma od ${state.displayName || "tohoto počítače"}`, peer: `Téma od ${state.remote.peerName || "partnera"}`, both: "Navrhli oba", unknown: "Přidáno dříve" },
    fr: { local: `Sujet de ${state.displayName || "cet ordinateur"}`, peer: `Sujet de ${state.remote.peerName || "partenaire"}`, both: "Proposé par les deux", unknown: "Ajouté auparavant" },
  }[language];
  const pageTitle = activeSection === "context" ? navigationText.contextTitle : activeSection === "people" ? navigationText.peopleTitle : activeSection === "reports" ? navigationText.reportsTitle : activeSection === "settings" ? navigationText.settingsTitle : state.onboardingComplete ? navigationText.connectionTitle : navigationText.setupTitle;
  const portraits = state.contextAnalysis?.portraits ?? [];
  const selectedPortrait = portraits.find((portrait) => portrait.personId === selectedPortraitId)
    ?? portraits.find((portrait) => portrait.isOwner)
    ?? portraits[0];
  const selectedPairPersonId = counterpartPersonId || state.preferredCounterpartPersonId || state.remote.counterpartPersonId;
  const localPairTopics = state.contextAnalysis?.topics.filter((item) => item.approved && item.discussWithPersonId === selectedPairPersonId).map((item) => item.title) ?? [];
  const displayedPairTopics = [...new Set([...localPairTopics, ...state.pairTopics, ...state.pendingTopics, ...state.activeTopics])];
  const visiblePairTopics = showAllPairTopics ? displayedPairTopics : displayedPairTopics.slice(0, 6);

  function topicSourceLabel(item: string) {
    const sources = new Set(state.topicSources[item] ?? []);
    if (localPairTopics.includes(item)) sources.add("local");
    if (sources.has("local") && sources.has("peer")) return sourceText.both;
    if (sources.has("local")) return sourceText.local;
    if (sources.has("peer")) return sourceText.peer;
    return sourceText.unknown;
  }

  function topicBrief(item: string) {
    const savedKey = Object.keys(state.topicBriefs).find((candidate) => topicKey(candidate) === topicKey(item));
    if (savedKey) return state.topicBriefs[savedKey];
    return shareableTopicBrief(state.contextAnalysis?.topics.find((candidate) => topicKey(candidate.title) === topicKey(item)));
  }

  function goTo(section: SectionId) {
    if (section !== activeSection && activeDictation && !window.confirm(dictationText[language].leave)) return false;
    setActiveSection(section);
    setShowContextPicker(false);
    if (section === "context" && !state.context && !contextThreads.length) void loadContextThreads();
    if (section !== "reports") window.setTimeout(() => document.getElementById(section)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
    return true;
  }
  openConversation.current = id => { if (goTo("reports")) { setSelectedReportId(id); setRevealToken(String(Date.now())); } };

  async function changeLanguage(value: Language) {
    setLanguage(value);
    localStorage.setItem("family-bridge-language", value);
    if (api) setState(await api.setLanguage(value));
  }

  const api = window.familyBridge;
  const attentionText = {
    ru: { waiting: "Есть вопросы к вам", open: "Открыть вопросы", draftError: "Не удалось сохранить черновик на этом компьютере. Не закрывайте приложение до отправки ответа." },
    en: { waiting: "Questions need your answer", open: "Open questions", draftError: "Could not save the draft on this computer. Keep the app open until you send your answer." },
    cs: { waiting: "Máme na vás otázky", open: "Otevřít otázky", draftError: "Koncept nelze uložit do počítače. Nezavírejte aplikaci před odesláním odpovědi." },
    fr: { waiting: "Des questions vous attendent", open: "Ouvrir les questions", draftError: "Impossible de sauvegarder le brouillon. Gardez l’application ouverte jusqu’à l’envoi." },
  }[language];
  useEffect(() => {
    try { localStorage.setItem(OWNER_DRAFTS_KEY, JSON.stringify(ownerAnswers)); }
    catch { setError(attentionText.draftError); }
  }, [ownerAnswers, attentionText.draftError]);

  useEffect(() => {
    // Conversation drafts are synchronously durable in localStorage. Their mere
    // existence is not active editing and must never hold an update forever.
    void api?.setUpdateBlocked?.(Boolean(newTopicActive || activeDictation || busy || editingTopicId || refiningTopicId || savingTopicId || answeringQuestionId || inviteCode.trim()), activeDictation ? "dictation" : editingTopicId || inviteCode.trim() ? "editing" : "activity").catch(() => undefined);
  }, [newTopicActive, activeDictation, busy, editingTopicId, refiningTopicId, savingTopicId, answeringQuestionId, inviteCode]);
  useEffect(() => {
    let active = true;
    let sequence = 0;
    const refreshState = () => {
      const request = ++sequence;
      if (!api) { setLoadFailed(true); return; }
      void loadSavedState(() => api.getState()).then((next) => {
      if (!active || request !== sequence) return;
      setState(next);
      setError((current) => clearRecoveredConnectionError(current, next.remote.connected));
      setLoaded(true);
      setLoadFailed(false);
      setLanguage(next.language);
      setDisplayName(next.displayName);
      setCounterpartPersonId((current) => current || next.remote.counterpartPersonId || next.contextAnalysis?.people[0]?.id || "");
      setReviewPersonId((current) => current || next.contextAnalysis?.people[0]?.id || "");
    }).catch(() => { if (active && request === sequence) setLoadFailed(true); });
    };
    refreshState();
    const onFocus = refreshState;
    window.addEventListener("focus", onFocus);
    const unsubscribe = api?.onEvent((raw) => {
      const navigation = raw as { type?: string; threadId?: string };
      if (navigation.type === "open-conversation" && navigation.threadId) { openConversation.current(navigation.threadId); return; }
      if ((raw as { type?: string }).type === "conversations") {
        setState((current) => applyConversationUpdate(current, raw as ConversationUpdateEvent));
        return;
      }
      const versionEvent = raw as { type?: string; peerVersionCheck?: AppState["remote"]["peerVersionCheck"] };
      const presenceEvent = raw as { type?: string; peerPresenceAt?: string };
      if (presenceEvent.type === "peer-presence") setState((current) => ({ ...current, remote: { ...current.remote, peerPresenceAt: presenceEvent.peerPresenceAt } }));
      if (versionEvent.type === "peer-version-check") setState((current) => ({ ...current, remote: { ...current.remote, peerVersionCheck: versionEvent.peerVersionCheck } }));
      const healthEvent = raw as { type?: string; codex?: AppState["codex"]; connected?: boolean };
      if (healthEvent.type === "continuation-updated") refreshState();
      if (healthEvent.type === "health" && healthEvent.codex) {
        const connected = Boolean(healthEvent.connected);
        setState((current) => ({ ...current, codex: healthEvent.codex!, remote: { ...current.remote, connected } }));
        setError((current) => clearRecoveredConnectionError(current, connected));
      }
      const event = raw as { type?: string; available?: boolean; version?: string; checking?: boolean; downloading?: boolean; ready?: boolean; error?: string; peerName?: string; peerVersion?: string; peerLastSeenAt?: string; context?: AppState["context"]; analysis?: AppState["contextAnalysis"]; topics?: string[]; pairTopics?: string[]; activeTopics?: string[]; topicSources?: AppState["topicSources"]; reports?: string[]; reportSummaries?: AppState["reportSummaries"]; questions?: AppState["ownerQuestions"]; running?: boolean; syncing?: boolean; updating?: boolean; progress?: number };
      if (event.type === "peer") setState((current) => ({ ...current, remote: { ...current.remote, ...(event.peerName ? { peerName: event.peerName } : {}), ...(event.peerVersion ? { peerVersion: event.peerVersion } : {}), ...(event.peerLastSeenAt ? { peerLastSeenAt: event.peerLastSeenAt } : {}) } }));
      if (event.type === "context" && event.context) setState((current) => ({ ...current, context: event.context }));
      if (event.type === "error" && event.error) setError(errorMessage(event.error));
      if (event.type === "context-analysis" && event.analysis) {
        setState((current) => ({ ...current, contextAnalysis: event.analysis }));
        setCounterpartPersonId((current) => current || event.analysis?.people[0]?.id || "");
        setReviewPersonId((current) => current && event.analysis?.people.some((person) => person.id === current) ? current : event.analysis?.people[0]?.id || "");
      }
      if (event.type === "intake" && (raw as { intake?: AppState["intake"] }).intake) {
        const intake = (raw as { intake: AppState["intake"] }).intake;
        setState(current => ({ ...current, intake }));
      }
      if (event.type === "topics" && event.topics) setState((current) => ({ ...current, pendingTopics: event.topics!, pairTopics: event.pairTopics ?? current.pairTopics, activeTopics: event.activeTopics ?? current.activeTopics, topicSources: event.topicSources ?? current.topicSources }));
      if (event.type === "reports" && event.reports && event.reportSummaries) setState((current) => ({ ...current, reports: event.reports!, reportSummaries: event.reportSummaries! }));
      if (event.type === "owner-questions" && event.questions) {
        setState((current) => ({ ...current, ownerQuestions: event.questions! }));
      }
      if (event.type === "context-sync") setState((current) => ({ ...current, contextSyncing: Boolean(event.syncing), contextSyncProgress: event.progress ?? 0 }));
      if (event.type === "portraits-updating") setState((current) => ({ ...current, portraitsUpdating: Boolean(event.updating) }));
      if (event.type === "runtime") { setBusy(Boolean(event.running)); setState((current) => ({ ...current, running: Boolean(event.running) })); }
      if (event.type === "update") setState((current) => ({ ...current, update: {
        available: Boolean(event.available),
        version: typeof event.version === "string" ? event.version : undefined,
        checking: Boolean(event.checking),
        downloading: Boolean(event.downloading),
        progress: typeof event.progress === "number" ? event.progress : undefined,
        ready: Boolean(event.ready),
        installRequested: Boolean((raw as AppState["update"]).installRequested),
        installing: Boolean((raw as AppState["update"]).installing),
        waitingFor: (raw as AppState["update"]).waitingFor,
        error: typeof event.error === "string" ? event.error : undefined,
      } }));
    });
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
      unsubscribe?.();
    };
  }, [api, reload]);

  useEffect(() => {
    if (loaded) void api?.diagnoseUi({ onboardingComplete: state.onboardingComplete, analysisStatus: state.contextAnalysis?.status }).catch(() => undefined);
  }, [api, loaded, state.onboardingComplete, state.contextAnalysis?.status]);

  useEffect(() => {
    if (!api || activeSection !== "settings") return;
    void api.getComputeState().then(compute => setState(current => ({ ...current, compute }))).catch(() => undefined);
  }, [api, activeSection]);

  useEffect(() => {
    if (!api || state.processingMode !== "trusted" || !["pending", "unavailable"].includes(state.compute.enrollmentStatus)) return;
    let active = true;
    const refresh = () => void api.getComputeState().then(compute => { if (active) setState(current => ({ ...current, compute })); }).catch(() => undefined);
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [api, state.processingMode, state.compute.enrollmentStatus]);

  useEffect(() => {
    if (!api || state.contextAnalysis?.status !== "analyzing") return;
    let active = true;
    const reconcile = () => void api.getState().then((local) => {
      if (!active) return;
      setState(local);
    }).catch(() => { if (active) setLoadFailed(true); });
    reconcile();
    const timer = window.setInterval(reconcile, 1_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [api, state.contextAnalysis?.status]);

  const continuationPending = state.continuationStates?.some((item) => item.status === "starting" || item.status === "waiting");
  useEffect(() => {
    if (!api || !continuationPending) return;
    let active = true;
    const timer = window.setInterval(() => { void api.getState().then((next) => { if (active) setState(next); }).catch(() => undefined); }, 3_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [api, continuationPending]);

  const health = useMemo(
    () => state.codex.installed && state.codex.authenticated || state.compute.mode === "client" && state.compute.connected,
    [state.codex, state.compute],
  );

  async function blockTopic() {
    if (!blocked.trim()) return;
    if (api) setState(await api.blockTopic(blocked));
    else setState((current) => ({ ...current, blockedTopics: [...current.blockedTopics, blocked] }));
    setBlocked("");
  }

  async function discussAllTopics() {
    if (!api || !state.pendingTopics.length) return;
    setBusy(true); setError("");
    try { setState(await api.discussAllTopics()); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function answerOwnerQuestion(id: string, disposition: "answer" | "unknown" | "decline") {
    if (!api || activeDictation || answeringQuestionId) return;
    setAnsweringQuestionId(id); setError("");
    try {
      const answer = ownerAnswers[id]?.trim() || "";
      setState(await api.answerOwnerQuestion({ id, disposition, answer }));
      setOwnerAnswers((current) => { const next = { ...current }; delete next[id]; return next; });
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setAnsweringQuestionId(""); }
  }

  async function saveManualContext() {
    if (!api) return;
    setContextLoading(true); setError("");
    try {
      const next = await api.createManualContext(manualContext);
      setState(next);
      setCounterpartPersonId(next.contextAnalysis?.people[0]?.id || "");
      setReviewPersonId(next.contextAnalysis?.people[0]?.id || "");
      setManualContextOpen(false);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setContextLoading(false); }
  }

  async function computeAction(action: () => Promise<AppState["compute"]>) {
    setComputeBusy(true); setError("");
    try { const compute = await action(); setState(current => ({ ...current, compute })); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setComputeBusy(false); }
  }

  async function chooseProcessingMode(mode: "local" | "trusted") {
    if (!api) return;
    setContextLoading(true); setError("");
    try { setState(await api.setProcessingMode(mode)); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setContextLoading(false); }
  }

  async function startIntake() {
    if (!api) return;
    setContextLoading(true); setError("");
    try { setState(await api.startPsychologistIntake()); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setContextLoading(false); }
  }

  async function sendIntake() {
    if (!api || !intakeDraft.trim()) return;
    const text = intakeDraft.trim(); setIntakeDraft(""); setContextLoading(true); setError("");
    try { setState(await api.sendPsychologistIntake(text)); }
    catch (reason) { setIntakeDraft(text); setError(errorMessage(reason)); }
    finally { setContextLoading(false); }
  }

  async function finalizeIntake() {
    if (!api) return;
    setContextLoading(true); setError("");
    try {
      const next = await api.finalizePsychologistIntake();
      setState(next);
      setCounterpartPersonId(next.contextAnalysis?.people[0]?.id || "");
      setReviewPersonId(next.contextAnalysis?.people[0]?.id || "");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setContextLoading(false); }
  }

  async function loadContextThreads() {
    if (!api) return;
    setContextLoading(true); setError(""); setShowContextPicker(true);
    try {
      const threads = await api.listContextThreads();
      setContextThreads(threads);
      const preferred = state.context?.id ? threads.find((thread) => thread.id === state.context?.id) : undefined;
      const selected = preferred ?? threads[0];
      setSelectedContextProject(selected?.project ?? "");
      setSelectedContextId(selected?.id ?? "");
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setContextLoading(false); }
  }

  function contextPicker() {
    if (contextLoading && !contextThreads.length) return <PendingStatus language={language}>{contextText.loading}</PendingStatus>;
    const projects = [...new Set(contextThreads.map((thread) => thread.project))].sort((left, right) => left.localeCompare(right, language));
    const chats = contextThreads.filter((thread) => thread.project === selectedContextProject);
    return <>
      <select aria-label={contextText.project} value={selectedContextProject} onChange={(event) => {
        const project = event.target.value;
        setSelectedContextProject(project);
        setSelectedContextId(contextThreads.find((thread) => thread.project === project)?.id ?? "");
      }}><option value="">{contextText.project}</option>{projects.map((project) => <option value={project} key={project}>{project}</option>)}</select>
      <select aria-label={contextText.chat} value={selectedContextId} onChange={(event) => setSelectedContextId(event.target.value)}><option value="">{contextText.chat}</option>{chats.map((thread) => <option value={thread.id} key={thread.id}>{thread.title}</option>)}</select>
      <button className="primary" aria-busy={contextLoading} disabled={!selectedContextId || contextLoading} onClick={() => void selectContext()}>{contextLoading && <LoaderCircle className="spin" size={16} />}{contextText.apply}</button>
      {contextLoading && <PendingStatus language={language}>{waitingText.context}</PendingStatus>}
    </>;
  }

  async function selectContext() {
    if (!api || !selectedContextId) return;
    setContextLoading(true); setError("");
    setState((current) => ({ ...current, contextAnalysis: undefined }));
    try { setState(await api.selectContextThread(selectedContextId)); setShowContextPicker(false); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setContextLoading(false); }
  }

  async function confirmSavedContext() {
    if (!api || !state.context?.id || contextLoading) return;
    setContextLoading(true); setError("");
    setState((current) => ({ ...current, context: current.context ? { ...current.context, status: "syncing" } : current.context, contextAnalysis: undefined }));
    try { setState(await api.selectContextThread(state.context.id)); setShowContextPicker(false); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setContextLoading(false); }
  }

  async function refreshContextNow() {
    if (!api) return;
    setContextLoading(true); setError("");
    try { setState(await api.refreshContextNow()); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setContextLoading(false); }
  }

  async function createInvite() {
    if (!api || !selectedPairPersonId || connectionAction) return;
    setConnectionAction("create"); setBusy(true); setError(""); setInviteCopied(false);
    try { setState(await api.createPair(selectedPairPersonId)); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setConnectionAction(""); setBusy(false); }
  }

  async function connectWithInvite() {
    if (!api || !selectedPairPersonId || !inviteCode.trim() || connectionAction) return;
    setConnectionAction("join"); setBusy(true); setError("");
    try { setState(await api.joinPair(inviteCode, selectedPairPersonId)); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setConnectionAction(""); setBusy(false); }
  }

  async function copyInvite() {
    if (!state.remote.invite) return;
    await navigator.clipboard.writeText(state.remote.invite);
    setInviteCopied(true);
  }

  async function checkPairVersions() {
    if (!api || !state.remote.configured || versionCheckBusy || state.remote.peerVersionCheck?.status === "checking") return;
    setVersionCheckBusy(true); setError("");
    try {
      setState(await api.checkPairVersions());
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setVersionCheckBusy(false); }
  }

  async function updateContextTopic(topicId: string, update: { aboutPersonIds?: string[]; discussWithPersonId?: string; approved?: boolean; dismissed?: boolean; title?: string; context?: string; goal?: string; openingQuestion?: string }) {
    if (!api) return;
    setError("");
    try { setState(await api.updateContextTopic({ topicId, ...update })); }
    catch (reason) { setError(errorMessage(reason)); }
  }

  function beginTopicEdit(item: NonNullable<AppState["contextAnalysis"]>["topics"][number]) {
    if (refiningTopicId || savingTopicId) return;
    topicEditSession.current++;
    const brief = shareableTopicBrief(item);
    setEditingTopicId(item.id);
    setTopicDraft({ title: item.title, context: brief?.context ?? "", goal: brief?.goal ?? "", openingQuestion: brief?.openingQuestion ?? "" });
    setTopicRefinementInstruction("");
    setTopicRefinementReady(false);
  }

  function cancelTopicEdit() {
    topicEditSession.current++;
    setEditingTopicId("");
    setTopicDraft({ title: "", context: "", goal: "", openingQuestion: "" });
    setTopicRefinementInstruction("");
    setTopicRefinementReady(false);
  }

  async function refineTopicEdit(topicId: string) {
    if (!api || refiningTopicId || !topicRefinementInstruction.trim()) return;
    setRefiningTopicId(topicId);
    setTopicRefinementReady(false);
    setError("");
    try {
      const session = topicEditSession.current;
      const preview = topicDraft.context && topicDraft.goal && topicDraft.openingQuestion ? topicDraft : undefined;
      const result = await api.refineContextTopic({ topicId, instruction: topicRefinementInstruction.trim(), preview });
      if (session !== topicEditSession.current) return;
      setTopicDraft(result);
      setTopicRefinementReady(true);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setRefiningTopicId(""); }
  }

  async function saveTopicEdit(topicId: string) {
    if (!api || savingTopicId || !topicRefinementReady || !topicDraft.title.trim() || !topicDraft.context.trim() || !topicDraft.goal.trim() || !topicDraft.openingQuestion.trim()) return;
    setSavingTopicId(topicId);
    setError("");
    try {
      setState(await api.updateContextTopic({ topicId, ...topicDraft }));
      setShowAllReviewTopics(true);
      cancelTopicEdit();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setSavingTopicId(""); }
  }

  async function savePortraitObservation(personId: string, observationId: string) {
    if (!api || !observationDraft.trim()) return;
    setError("");
    try {
      setState(await api.updatePortraitObservation({ personId, observationId, text: observationDraft }));
      setEditingObservationId("");
      setObservationDraft("");
    } catch (reason) { setError(errorMessage(reason)); }
  }

  async function removePortraitObservation(personId: string, observationId: string) {
    if (!api || !window.confirm(portraitText.removeConfirm)) return;
    setError("");
    try { setState(await api.updatePortraitObservation({ personId, observationId, remove: true })); }
    catch (reason) { setError(errorMessage(reason)); }
  }

  async function completeOnboarding(personId: string) {
    if (!api) return;
    setError("");
    try { setState(await api.completeOnboarding(personId)); setCounterpartPersonId(personId); }
    catch (reason) { setError(errorMessage(reason)); }
  }

  async function approveSafeTopics(personId: string) {
    if (!api || !state.contextAnalysis) return;
    const topicIds = suggestedTopics(state.contextAnalysis.topics, state).filter((item) => item.discussWithPersonId === personId && !topicNeedsReview(item)).map((item) => item.id);
    if (!topicIds.length) return;
    setError("");
    try { setState(await api.updateContextTopics({ topicIds, approved: true })); }
    catch (reason) { setError(errorMessage(reason)); }
  }

  function toggleTopicDetails(topicId: string) {
    setExpandedTopicIds((current) => {
      const next = new Set(current);
      if (next.has(topicId)) next.delete(topicId); else next.add(topicId);
      return next;
    });
  }

  function personLabel(personId: string) {
    const person = state.contextAnalysis?.people.find((item) => item.id === personId);
    return person?.label || "—";
  }

  function topicRegistry() {
    if (!state.contextAnalysis?.people.length) return <div className="empty">{onboardingText.noPeople}</div>;
    const unstarted = state.contextAnalysis.topics.filter(topic => !topicAlreadyStarted(topic, state));
    const registryTopics = unstarted.filter(topic => Boolean(topic.dismissed) === (topicFilter === "dismissed"));
    const topicPeople = state.context?.source === "manual"
      ? state.contextAnalysis.people
      : state.contextAnalysis.people.filter((person) => unstarted.some((topic) => topic.discussWithPersonId === person.id));
    if (!topicPeople.length) return <div className="empty">{registryText.noFilteredTopics}</div>;
    const selectedPerson = topicPeople.find((person) => person.id === reviewPersonId)
      ?? topicPeople.find((person) => person.id === state.preferredCounterpartPersonId)
      ?? topicPeople.find((person) => person.id === state.remote.counterpartPersonId)
      ?? topicPeople[0];
    const allForPerson = registryTopics.filter((item) => item.discussWithPersonId === selectedPerson.id);
    const selectedPersonTopics = allForPerson
      .filter((item) => topicFilter === "all" || topicFilter === "dismissed" || topicFilter === "approved" && item.approved || topicFilter === "review" && topicNeedsReview(item))
      // Preserve the model's importance order; do not alphabetize the agenda.
      .filter((item) => !topicSearch.trim() || `${item.title} ${item.reason}`.toLocaleLowerCase(language).includes(topicSearch.trim().toLocaleLowerCase(language)));
    const visibleTopics = showAllReviewTopics || topicSearch.trim() || topicFilter !== "all" ? selectedPersonTopics : selectedPersonTopics.slice(0, 6);
    const reviewCount = allForPerson.filter(topicNeedsReview).length;
    const approvedCount = allForPerson.filter((item) => item.approved).length;
    return <div className="topic-registry">
      <p className="registry-hint">{suggestionText.hint}</p><div className="person-tabs" role="tablist">{topicPeople.map((person) => {
        const count = registryTopics.filter((item) => item.discussWithPersonId === person.id).length;
        return <button type="button" role="tab" aria-selected={person.id === selectedPerson.id} className={person.id === selectedPerson.id ? "active" : ""} key={person.id} onClick={() => { setReviewPersonId(person.id); setShowAllReviewTopics(false); }}>{personLabel(person.id)} <span>{count}</span></button>;
      })}</div>
      <div className="registry-heading"><div><h4>{registryText.topicsFor}: {personLabel(selectedPerson.id)}</h4><p>{allForPerson.length} · {reviewCount} {registryText.needReview}</p></div>{allForPerson.length > 0 && <div className="registry-controls"><input value={topicSearch} onChange={(event) => setTopicSearch(event.target.value)} placeholder={registryText.search} aria-label={registryText.search} /><div className="registry-filters"><button className={topicFilter === "all" ? "active" : ""} onClick={() => setTopicFilter("all")}>{registryText.all}</button><button className={topicFilter === "review" ? "active" : ""} onClick={() => setTopicFilter("review")}>{registryText.review}</button><button className={topicFilter === "approved" ? "active" : ""} onClick={() => setTopicFilter("approved")}>{registryText.approved}</button><button className={topicFilter === "dismissed" ? "active" : ""} onClick={() => setTopicFilter("dismissed")}>{suggestionText.removed}</button></div></div>}</div>
      <div className="registry-toolbar"><span>{approvedCount} {registryText.allowedOf} {allForPerson.length}</span>{topicFilter !== "dismissed" && <button className="ghost" onClick={() => void approveSafeTopics(selectedPerson.id)}>{registryText.allowSafe}</button>}</div>
      <div className="topic-rows">{visibleTopics.map((item) => {
        const expanded = expandedTopicIds.has(item.id);
        const editing = editingTopicId === item.id;
        const about = item.aboutPersonIds.map(personLabel).join(", ") || "—";
        const brief = shareableTopicBrief(item);
        return <div className={`topic-row ${item.sensitivity} ${expanded ? "expanded" : ""}`} key={item.id}>
          <div className="topic-row-main"><label className="topic-approval"><input type="checkbox" checked={item.approved} disabled={item.dismissed || editing || savingTopicId === item.id} onChange={(event) => void updateContextTopic(item.id, { approved: event.target.checked })} /><span className="topic-approval-copy"><strong>{item.title}</strong>{brief?.context && <small>{brief.context}</small>}</span></label><span className="topic-about">{workflowText.about}: {about}{item.sensitivity !== "direct" ? ` · ${registryText.review}` : ""}{item.relevance === "check_relevance" ? ` · ${topicRelevanceLabel(language)}` : ""}</span><button className="topic-dismiss" disabled={editing || Boolean(refiningTopicId || savingTopicId)} aria-label={`${item.dismissed ? suggestionText.restore : suggestionText.remove}: ${item.title}`} title={item.dismissed ? suggestionText.restore : suggestionText.remove} onClick={() => void updateContextTopic(item.id, { dismissed: !item.dismissed })}>{item.dismissed ? <RefreshCw size={16} /> : <Trash2 size={16} />}</button><button className="topic-expand" aria-label={expanded ? registryText.collapse : registryText.expand} aria-expanded={expanded} onClick={() => toggleTopicDetails(item.id)}><ChevronDown size={17} /></button></div>
          {expanded && <div className="topic-row-detail">
            {editing ? <div className="topic-edit">
              <TopicRefinementRequest language={language} text={registryText} instruction={topicRefinementInstruction} pending={refiningTopicId === item.id} ready={topicRefinementReady} onChange={(value) => { setTopicRefinementInstruction(value); setTopicRefinementReady(false); }} onRefine={() => void refineTopicEdit(item.id)} onCancel={cancelTopicEdit} />
              {savingTopicId === item.id && <PendingStatus language={language}>{waitingText.save}</PendingStatus>}
              {topicRefinementReady && <>
                <div className="topic-preview-heading"><strong>{registryText.preview}</strong><span><Check size={15} />{registryText.prepared}</span><small>{registryText.previewHint}</small></div>
                <div className="topic-preview-card">
                  <div className="topic-preview-title"><small>{registryText.topicLabel}</small><h5>{topicDraft.title}</h5></div>
                  <div><small>{registryText.context}</small><p>{topicDraft.context}</p></div>
                  <div><small>{registryText.goal}</small><p>{topicDraft.goal}</p></div>
                  <div className="topic-preview-opening"><small>{registryText.opening}</small><p>«{topicDraft.openingQuestion}»</p></div>
                </div>
                <small>{registryText.editHint}</small>
                <div className="actions topic-edit-actions"><button className="primary" disabled={savingTopicId === item.id} onClick={() => void saveTopicEdit(item.id)}>{registryText.save}</button><button className="ghost" disabled={savingTopicId === item.id} onClick={() => setTopicRefinementReady(false)}>{registryText.retry}</button><button className="ghost" disabled={savingTopicId === item.id} onClick={cancelTopicEdit}>{registryText.cancel}</button></div>
              </>}
            </div> : <div className="topic-brief-grid">{brief?.context && <div><small>{registryText.context}</small><p>{brief.context}</p></div>}{brief?.goal && <div><small>{registryText.goal}</small><p>{brief.goal}</p></div>}{brief?.openingQuestion && <div className="topic-opening"><small>{registryText.opening}</small><p>«{brief.openingQuestion}»</p></div>}</div>}
            <div className="route-fields"><label>{workflowText.about}<select disabled={editing} value={item.aboutPersonIds[0] || ""} onChange={(event) => void updateContextTopic(item.id, { aboutPersonIds: [event.target.value] })}>{state.contextAnalysis!.people.map((person) => <option value={person.id} key={person.id}>{personLabel(person.id)}</option>)}</select></label><label>{workflowText.with}<select disabled={editing} value={item.discussWithPersonId} onChange={(event) => void updateContextTopic(item.id, { discussWithPersonId: event.target.value })}>{state.contextAnalysis!.people.map((person) => <option value={person.id} key={person.id}>{personLabel(person.id)}</option>)}</select></label></div>
            {item.sensitivity === "cross_person" && <small className="route-warning">{workflowText.cross}</small>}{item.sensitivity === "unclear" && <small className="route-warning">{workflowText.unclear}</small>}
            {!editing && !item.dismissed && <div className="topic-refine">{item.approved ? <small>{registryText.selectedHint}</small> : <button className="ghost" disabled={Boolean(refiningTopicId || savingTopicId)} title={refiningTopicId ? registryText.preparing : undefined} onClick={() => beginTopicEdit(item)}>{registryText.refine}</button>}</div>}
          </div>}
        </div>;
      })}{!selectedPersonTopics.length && <div className="empty">{registryText.noFilteredTopics}</div>}</div>
      {!topicSearch.trim() && topicFilter === "all" && selectedPersonTopics.length > 6 && <button className="topic-list-toggle" onClick={() => setShowAllReviewTopics((value) => !value)}>{showAllReviewTopics ? registryText.less : `${registryText.more} · ${selectedPersonTopics.length - 6}`}</button>}
      {!state.onboardingComplete && <div className="onboarding-finish"><button className="primary" disabled={!approvedCount && state.context?.source !== "manual"} onClick={() => void completeOnboarding(selectedPerson.id)}>{state.context?.source === "manual" ? `Продолжить с ${personLabel(selectedPerson.id)} — тему можно добавить позже` : `${onboardingText.finish}: ${personLabel(selectedPerson.id)}`}</button></div>}
    </div>;
  }

  const knownVersions = [state.appVersion, state.update.version, state.remote.peerVersion].filter((value): value is string => Boolean(value));
  const latestKnownVersion = knownVersions.sort(compareVersions).at(-1) ?? state.appVersion;
  const localVersionCurrent = compareVersions(state.appVersion, latestKnownVersion) === 0;

  const loadingText = {
    ru: ["Открываем сохранённые данные…", "Не удалось загрузить состояние приложения. Это не первый запуск и не сброс данных.", "Повторить", "Открыть журнал диагностики"],
    en: ["Opening saved data…", "Could not load app state. This is not a first run or a data reset.", "Retry", "Open diagnostic log"],
    cs: ["Otevíráme uložená data…", "Stav aplikace nelze načíst. Nejde o první spuštění ani smazání dat.", "Zkusit znovu", "Otevřít diagnostický protokol"],
    fr: ["Ouverture des données enregistrées…", "Impossible de charger l’état. Ce n’est ni un premier démarrage ni une remise à zéro.", "Réessayer", "Ouvrir le journal"],
  }[language];
  if (!loaded) return <div className="startup-status"><h1>Family Bridge</h1>{loadFailed ? <p role="alert">{loadingText[1]}</p> : <PendingStatus language={language}>{loadingText[0]}</PendingStatus>}{loadFailed && <button onClick={() => { setLoadFailed(false); setReload((value) => value + 1); }}>{loadingText[2]}</button>}</div>;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><MessageCircleHeart size={25} /><span>Family Bridge</span></div>
        <nav>
          <button className={activeSection === "overview" ? "active" : ""} onClick={() => goTo("overview")}><Activity size={18} /><span>{state.onboardingComplete ? navigationText.connection : navigationText.start}</span>{state.ownerQuestions.length > 0 && <b className="nav-badge">{state.ownerQuestions.length}</b>}</button>
          <button className={activeSection === "context" ? "active" : ""} onClick={() => goTo("context")}><BookHeart size={18} />{navigationText.context}</button>
          <button className={activeSection === "people" ? "active" : ""} onClick={() => goTo("people")}><UserRound size={18} />{navigationText.people}</button>
          <button className={activeSection === "reports" ? "active" : ""} onClick={() => goTo("reports")}><ScrollText size={18} />{navigationText.reports}{reading.unreadCount > 0 && <b className="nav-badge unread-nav">{reading.unreadCount}</b>}</button>
          <button className={activeSection === "settings" ? "active" : ""} onClick={() => goTo("settings")}><Settings2 size={18} />{navigationText.settings}</button>
        </nav>
        <div className="sidebar-footer"><div className="sidebar-status">
          <span className={health ? "status-dot online" : "status-dot"} />
          <div><strong>{health ? t.ready : t.setup}</strong><small>Family Bridge v{state.appVersion}</small><small>{state.codex.version}</small></div>
        </div><UpdateControl compact update={state.update} version={state.appVersion} language={language} onCheck={async () => api?.checkForUpdates()} onInstall={async () => api?.installUpdate()} /></div>
      </aside>

      <main id="overview" className={`${!state.onboardingComplete && activeSection === "overview" ? "onboarding-main" : ""} ${activeSection === "context" ? "context-main" : ""}`.trim()}>
        <header>
          <div><h1>{pageTitle}</h1></div>
          <div className="header-tools"><label>{t.language}<select value={language} onChange={(e) => void changeLanguage(e.target.value as Language)}>{(Object.keys(languageNames) as Language[]).map((key) => <option value={key} key={key}>{languageNames[key]}</option>)}</select></label><div className="live-pill"><CircleDot size={14} />{t.background}</div></div>
        </header>
        {loadFailed && <div className="error" role="alert">{loadingText[1]} <button onClick={() => setReload((value) => value + 1)}>{loadingText[2]}</button></div>}

        {state.contextSyncing && state.context && <section className="context-refresh-note"><LoaderCircle className="spin" size={18} /><div><div className="context-refresh-title"><strong>{contextRefreshText.title}</strong><b>{state.contextSyncProgress}%</b></div><span>{contextRefreshText.body}</span><progress max="100" value={state.contextSyncProgress} /></div></section>}

        {activeSection !== "overview" && state.ownerQuestions.length > 0 && <div className="attention-note" role="status"><Bell size={18} /><span>{attentionText.waiting} · {state.ownerQuestions.length}</span><button className="ghost" onClick={() => goTo("overview")}>{attentionText.open}</button></div>}

        {activeSection === "overview" && state.ownerQuestions.map((item) => <section className="panel owner-question-panel" key={item.id}>
          <div className="owner-question-heading"><div><p className="eyebrow">{ownerQuestionText.eyebrow}</p><h3>{ownerQuestionText.title}</h3></div><Bell size={21} /></div>
          <div className="owner-question-topic"><span>{ownerQuestionText.paused}</span><strong>{item.topic}</strong></div>
          <p className="owner-question">{item.question}</p>
          <p className="owner-question-privacy"><ShieldCheck size={15} />{ownerQuestionText.privacy}</p>
          <textarea aria-label={`${ownerQuestionText.placeholder}: ${item.topic}`} value={ownerAnswers[item.id] || ""} onChange={(event) => setOwnerAnswers((current) => ({ ...current, [item.id]: event.target.value }))} placeholder={ownerQuestionText.placeholder} disabled={answeringQuestionId === item.id} />
          <DictationControl language={language} disabled={Boolean(answeringQuestionId) || Boolean(activeDictation && activeDictation !== item.id)} onText={(text) => setOwnerAnswers((current) => ({ ...current, [item.id]: appendDictation(current[item.id] || "", text) }))} onBusyChange={(value) => setActiveDictation((current) => value ? item.id : current === item.id ? "" : current)} />
          <div className="owner-question-actions">
            <button className="primary" aria-busy={answeringQuestionId === item.id} disabled={!ownerAnswers[item.id]?.trim() || Boolean(answeringQuestionId) || Boolean(activeDictation)} onClick={() => void answerOwnerQuestion(item.id, "answer")}>{answeringQuestionId === item.id && <LoaderCircle className="spin" size={16} />}{answeringQuestionId === item.id ? ownerQuestionText.processing : ownerQuestionText.answer}</button>
            <button className="ghost" disabled={Boolean(answeringQuestionId) || Boolean(activeDictation)} onClick={() => void answerOwnerQuestion(item.id, "unknown")}>{ownerQuestionText.unknown}</button>
            <button className="ghost" disabled={Boolean(answeringQuestionId) || Boolean(activeDictation)} onClick={() => void answerOwnerQuestion(item.id, "decline")}>{ownerQuestionText.decline}</button>
          </div>
        </section>)}

        {activeSection === "overview" && !state.onboardingComplete && <section className="panel onboarding-panel">
          {!state.processingMode && <div className="onboarding-stage"><h3>{setupText.chooseTitle}</h3><p>{setupText.chooseBody}</p><div className="processing-choice"><button className="primary" disabled={contextLoading} onClick={() => void chooseProcessingMode("local")}><strong>{setupText.localTitle}</strong><span>{setupText.localBody}</span></button><button className="ghost" disabled={contextLoading} onClick={() => void chooseProcessingMode("trusted")}><strong>{setupText.trustedTitle}</strong><span>{setupText.trustedBody}</span></button></div></div>}
          {state.processingMode && state.contextAnalysis?.status !== "ready" && <div className="onboarding-intro"><p>{onboardingText.lead}</p></div>}
          {state.processingMode && <div className="onboarding-steps"><div className={state.context && state.context.status !== "confirmation" ? "done" : "active"}><span>{state.context && state.context.status !== "confirmation" ? <Check size={16} /> : "1"}</span>{onboardingText.chooseTitle}</div><div className={state.contextAnalysis?.status === "ready" ? "done" : state.context && state.context.status !== "confirmation" ? "active" : ""}><span>{state.contextAnalysis?.status === "ready" ? <Check size={16} /> : "2"}</span>{onboardingText.processingTitle}</div><div className={state.contextAnalysis?.status === "ready" ? "active" : ""}><span>3</span>{onboardingText.reviewTitle}</div></div>}
          {state.processingMode === "local" && !state.context && (state.intake.status === "idle" || state.intake.status === "error" && !state.intake.messages.length) && <div className="onboarding-stage"><h3>{setupText.localTitle}</h3><p>{state.codex.installed ? state.codex.authenticated ? `${setupText.ready} · ${state.codex.version}` : setupText.signInNeeded : setupText.runtimeMissing}</p>{state.intake.error && <p role="alert">{state.intake.error}</p>}<div className="actions">{!state.codex.authenticated && <button className="primary" disabled={!state.codex.installed || contextLoading} onClick={async () => { if (!api) return; await api.startCodexLogin(); setError(setupText.signInOpened); }}>{setupText.signIn}</button>}<button className="ghost" onClick={async () => { if (!api) return; const codex = await api.refreshCodexStatus(); setState(current => ({ ...current, codex })); }}>{setupText.checkSignIn}</button></div>{state.codex.authenticated && <><p>{setupText.sourceChoice}</p><div className="actions"><button className="primary" disabled={contextLoading} onClick={() => void loadContextThreads()}>{contextText.choose}</button><button className="ghost" disabled={contextLoading} onClick={() => void startIntake()}>{state.intake.status === "error" ? setupText.retryConversation : setupText.newConversation}</button></div></>}</div>}
          {state.processingMode === "trusted" && !state.context && !state.compute.connected && <div className="onboarding-stage"><h3>{setupText.trustedTitle}</h3><p>{state.compute.enrollmentStatus === "rejected" ? setupText.trustedRejected : state.compute.enrollmentStatus === "unavailable" ? setupText.trustedOffline : setupText.trustedPending}</p>{state.compute.enrollmentStatus === "rejected" && <button onClick={() => api && void computeAction(() => api.requestTrustedComputer())}>{setupText.retryRequest}</button>}</div>}
          {state.processingMode === "trusted" && !state.context && state.compute.connected && (state.intake.status === "idle" || state.intake.status === "error" && !state.intake.messages.length) && <div className="onboarding-stage"><h3>{setupText.firstConversation}</h3><p>{setupText.firstConversationBody}</p>{state.intake.error && <p role="alert">{state.intake.error}</p>}<button className="primary" disabled={contextLoading} onClick={() => void startIntake()}>{state.intake.status === "error" ? setupText.retryConversation : setupText.startConversation}</button></div>}
          {!state.context && state.intake.messages.length > 0 && <div className="onboarding-stage intake-stage"><h3>{setupText.intakeTitle}</h3><div className="intake-messages">{state.intake.messages.map(message => <div key={message.id} className={`intake-message ${message.role}`}><strong>{message.role === "user" ? setupText.you : setupText.psychologist}</strong><p>{message.text}</p></div>)}</div>{state.intake.error && <p role="alert">{state.intake.error}</p>}<textarea value={intakeDraft} disabled={contextLoading || ["finalizing", "complete"].includes(state.intake.status)} onChange={event => setIntakeDraft(event.target.value)} placeholder={setupText.placeholder} onKeyDown={event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void sendIntake(); }} /><div className="actions">{state.intake.status !== "complete" && <button className="primary" disabled={contextLoading || !intakeDraft.trim()} onClick={() => void sendIntake()}>{contextLoading ? setupText.waitingReply : state.intake.pendingMessageId ? setupText.retrySend : setupText.send}</button>}{(state.intake.status === "ready" || state.intake.status === "complete" || state.intake.status === "error" && !state.intake.pendingMessageId) && <button className="ghost" disabled={contextLoading} onClick={() => void finalizeIntake()}>{state.intake.status === "complete" ? setupText.finishSaving : setupText.preparePeople}</button>}</div><small>{setupText.durable}</small></div>}
          {state.context?.status === "confirmation" && <div className="onboarding-stage context-confirmation"><h3>{onboardingText.chooseTitle}</h3><p>{onboardingText.confirmHint}</p><div className="processing-source"><strong>{state.context.project} · {state.context.title}</strong><small>{state.context.messageCount ?? 0} {contextText.messages.toLowerCase()}</small></div><div className="actions"><button className="primary" disabled={contextLoading} onClick={() => void confirmSavedContext()}>{onboardingText.useSaved}</button><button className="ghost" disabled={contextLoading} onClick={() => void loadContextThreads()}>{contextText.change}</button></div></div>}
          {showContextPicker && (!state.context || state.context.status === "confirmation") && <div className="context-picker onboarding-picker">{contextPicker()}</div>}
          {state.context && state.context.status !== "confirmation" && state.contextAnalysis?.status !== "ready" && (() => { if (state.context?.status === "error" || state.contextAnalysis?.status === "error") return <div className="onboarding-stage" role="alert"><p>{state.contextAnalysis?.error || state.context?.error}</p><button onClick={() => void api?.refreshContextNow().then(setState).catch(() => setError(loadingText[1]))}>{loadingText[2]}</button><button className="ghost" onClick={() => void loadContextThreads()}>{contextText.change}</button></div>; const hasSavedAnalysis = Boolean(state.contextAnalysis?.people.length || state.contextAnalysis?.topics.length); const finalizing = state.contextAnalysis?.progress?.stage === "consolidating"; return <div className="onboarding-stage processing-stage"><h3>{hasSavedAnalysis ? onboardingText.resumeTitle : onboardingText.processingTitle}</h3><div className="processing-source"><strong>{state.context.project} · {state.context.title}</strong><small>{state.context.messageCount ?? 0} {contextText.messages.toLowerCase()}</small></div><div className="processing-list"><div className={state.context.status === "ready" ? "done" : "active"}>{state.context.status === "ready" ? <Check size={18} /> : <LoaderCircle className="spin" size={18} />}<span>{onboardingText.export}</span></div><div className={hasSavedAnalysis || finalizing ? "done" : state.contextAnalysis ? "active" : "waiting"}>{hasSavedAnalysis || finalizing ? <Check size={18} /> : <LoaderCircle className={state.contextAnalysis ? "spin" : ""} size={18} />}<span>{onboardingText.people}</span></div><div className={state.contextAnalysis ? "active" : "waiting"}><LoaderCircle className={state.contextAnalysis ? "spin" : ""} size={18} /><span>{finalizing ? onboardingText.finalizing : onboardingText.topics}{state.contextAnalysis?.progress && !finalizing ? ` · ${state.contextAnalysis.progress.current}/${Math.max(1, state.contextAnalysis.progress.total - 1)}` : ""}</span></div></div><p className="muted">{hasSavedAnalysis ? onboardingText.resumeWaiting : onboardingText.waiting}</p></div>; })()}
          {state.contextAnalysis?.status === "ready" && <div className="onboarding-stage review-stage"><div className="review-intro"><div><h3>{onboardingText.reviewTitle}</h3><p>{onboardingText.reviewHint}</p></div><button className="ghost" onClick={() => void loadContextThreads()}>{contextText.change}</button></div>{showContextPicker && <div className="context-picker onboarding-picker">{contextPicker()}</div>}{topicRegistry()}</div>}
        </section>}

        {activeSection === "overview" && state.onboardingComplete && <section className="hero-card">
          <div>
            <span className="hero-icon"><ShieldCheck /></span>
            <p className="eyebrow">{t.state}</p>
            <h2>{state.running || busy && !connectionAction ? t.talking : t.waiting}</h2>
            <p>{t.privacy}</p>
          </div>
          <div className="hero-metrics">
            <div><span>Codex</span><strong>{health ? t.connected : t.notReady}</strong></div>
            <div><span>{t.queued}</span><strong>{displayedPairTopics.length}</strong></div>
            <div><span>{t.last}</span><strong>{state.lastConversationAt ? new Date(state.lastConversationAt).toLocaleDateString(language) : "—"}</strong></div>
          </div>
        </section>}

        {activeSection === "overview" && state.onboardingComplete && <section className="panel pairing-panel screen-panel">
          <div className="panel-title"><div><p className="eyebrow">{workflowText.connection}</p><h3>{state.remote.connected ? workflowText.connected : workflowText.link}</h3></div><Radio size={20} /></div>
          {!state.identityConfigured && <div className="identity-setup"><strong>{deviceText.question}</strong><span>{deviceText.hint}</span><div className="input-row"><input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={deviceText.placeholder} onKeyDown={async (e) => { if (e.key === "Enter" && api && displayName.trim()) setState(await api.setDisplayName(displayName)); }} /><button className="primary" disabled={!displayName.trim()} onClick={async () => api && setState(await api.setDisplayName(displayName))}>{deviceText.save}</button></div></div>}
          {state.remote.configured && !state.remote.connected && Boolean(state.remote.peerLastSeenAt) && <p className="notice" role="status">{{ru:"Прежнее подключение сохранено. Сейчас нет доступа к серверу пары; приложение повторяет проверку. Создавать новый код не нужно.",en:"Your existing connection is saved. Pair server access is unavailable; the app is retrying. You do not need a new invitation.",cs:"Původní propojení je uložené. Přístup k serveru páru nyní není dostupný; aplikace kontrolu opakuje. Nový kód není potřeba.",fr:"La connexion existante est conservée. L’accès au serveur est indisponible ; l’application réessaie. Aucun nouveau code n’est nécessaire."}[language]}</p>}
          {state.identityConfigured && !state.remote.connected && !state.remote.peerLastSeenAt && <>
            {state.contextAnalysis?.people.length ? <>
              <label className="counterpart-select"><span>{workflowText.who}</span><select value={selectedPairPersonId || ""} onChange={(e) => setCounterpartPersonId(e.target.value)}><option value="">{workflowText.choosePerson}</option>{state.contextAnalysis.people.map((person) => <option key={person.id} value={person.id}>{personLabel(person.id)}</option>)}</select></label>
              <div className="pair-actions"><button className="primary" aria-busy={connectionAction === "create"} disabled={!selectedPairPersonId || busy || Boolean(connectionAction)} onClick={() => void createInvite()}>{connectionAction === "create" && <LoaderCircle className="spin" size={16} />}{connectionAction === "create" ? waitingText.create : state.remote.invite ? workflowText.recreate : workflowText.create}</button></div>
              {state.remote.invite && <div className="invite-box"><p>{t.shareCode}</p><textarea readOnly value={state.remote.invite} onFocus={(e) => e.currentTarget.select()} /><button className="ghost" onClick={() => void copyInvite()}>{inviteCopied ? workflowText.copied : workflowText.copy}</button></div>}
              <div className="join-box"><span>{workflowText.orJoin}</span><div className="input-row"><input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder={t.pasteInvite}/><button aria-busy={connectionAction === "join"} disabled={!selectedPairPersonId || !inviteCode.trim() || busy || Boolean(connectionAction)} onClick={() => void connectWithInvite()}>{connectionAction === "join" && <LoaderCircle className="spin" size={16} />}{connectionAction === "join" ? waitingText.join : workflowText.connect}</button></div></div>
              {connectionAction && <PendingStatus language={language}>{waitingText[connectionAction]}</PendingStatus>}
            </> : <div className="context-needed"><span>{workflowText.needContext}</span><button className="ghost" onClick={() => goTo("context")}>{workflowText.openContext}</button></div>}
          </>}
          {state.remote.configured && <div className="connected-card">
            <strong>{state.remote.peerName || deviceText.partnerName}</strong>
            <span>{workflowText.mapped}: {state.remote.counterpartLabel || "—"}</span>
            <div className="pair-versions">
              <div><span>{pairVersionText.local}</span><strong>v{state.appVersion}</strong><small className={localVersionCurrent ? "version-current" : "version-old"}>{localVersionCurrent ? pairVersionText.current : pairVersionText.updateNeeded}</small></div>
              <PeerVersionControl state={state} language={language} onCheck={() => void checkPairVersions()} busy={versionCheckBusy} />
            </div>
          </div>}
        </section>}

        <div className="grid single-screen">
          {activeSection === "context" && <section className="panel context-panel">
            <div className="panel-title"><div><p className="eyebrow">{contextText.eyebrow}</p><h3>{contextText.title}</h3></div><BookHeart size={20} /></div>
            {state.context ? <div className="context-current">
              <div><span>{contextText.project}</span><strong>{state.context.project}</strong></div>
              <div><span>{contextText.chat}</span><strong>{state.context.title}</strong></div>
              <div><span>{contextText.messages}</span><strong>{state.context.messageCount ?? "—"}</strong></div>
              <div><span>{contextText.learned}</span><strong>{state.memory.learnedCount ?? 0}</strong></div>
              <div><span>{contextText.synced}</span><strong>{state.context.lastSyncedAt ? new Date(state.context.lastSyncedAt).toLocaleString(language) : "—"}</strong></div>
            </div> : <><strong className="context-empty">{contextText.none}</strong><p className="muted">{contextText.explanation}</p></>}
            <div className="actions"><button className="ghost" disabled={contextLoading} onClick={() => void loadContextThreads()}>{state.context ? contextText.change : contextText.choose}</button>{state.context && <button className="ghost" aria-busy={contextLoading || state.contextSyncing} disabled={contextLoading || state.contextSyncing} onClick={() => void refreshContextNow()}>{(contextLoading || state.contextSyncing) && <LoaderCircle className="spin" size={16} />}{contextText.refresh}</button>}</div>
            {contextLoading && !showContextPicker && !state.contextSyncing && <PendingStatus language={language}>{`${contextText.refresh}…`}</PendingStatus>}
            {showContextPicker && <div className="context-picker">
              {contextPicker()}
            </div>}
            {state.context?.status === "error" && <p className="muted">{state.context.error}</p>}
          </section>}
          {activeSection === "context" && <section className="panel analysis-panel">
            <div className="panel-title"><div><p className="eyebrow">{workflowText.analysis}</p><h3>{workflowText.analysisTitle}</h3></div><Sparkles size={20} /></div>
            {state.contextAnalysis?.status === "analyzing" && <div className="analysis-status">{workflowText.analyzing}</div>}
            {!state.contextAnalysis && <div className="empty">{workflowText.noAnalysis}</div>}
            {state.contextAnalysis?.status === "error" && <div className="analysis-error">{state.contextAnalysis.error}</div>}
            {state.contextAnalysis && <>
              <details className="people-block"><summary>{workflowText.people} · {state.contextAnalysis.people.length}</summary><div>{state.contextAnalysis.people.map((person) => <span className="person-chip" key={person.id}>{personLabel(person.id)}</span>)}</div></details>
              {topicRegistry()}
            </>}
          </section>}

          {activeSection === "overview" && state.onboardingComplete && <section className="panel topics-panel">
            <div className="panel-title"><div><p className="eyebrow">{workflowText.topics}</p><h3>{workflowText.topicTitle}</h3></div><Plus size={20} /></div>
            <p className="topic-explanation">{workflowText.topicHint}</p>
            {!state.remote.connected && selectedPairPersonId && <p className="topic-preview-note">{workflowText.localPreview}</p>}
            {state.remote.connected && state.remote.dialogueCompatible === false && <div className="notice">{compatibilityText}</div>}
            <NewTopicComposer key={state.remote.pairId || "unpaired"} state={state} language={language} onState={setState} onActive={setNewTopicActive} />
            <div className="topic-list">{visiblePairTopics.map((item) => {
              const report = state.reportSummaries.find((candidate) => candidate.topic === item);
              const active = state.activeTopics.includes(item);
              const pending = state.pendingTopics.includes(item);
              const brief = topicBrief(item);
              const status = state.ownerQuestions.some(question => question.topic === item) ? topicStatusText.question : active ? topicStatusText.active : report ? topicStatusText.complete : pending ? topicStatusText.pending : topicStatusText.selected;
              return <div className="topic pair-topic" key={item}><div className="topic-copy"><span>{item}</span>{(brief?.context || brief?.goal) && <p className="topic-context">{brief.context || brief.goal}</p>}<small>{topicSourceLabel(item)}</small></div><button className={`topic-state ${report ? "complete" : active ? "active" : ""}`} disabled={!report} onClick={() => { if (report) { setSelectedReportId(report.id); goTo("reports"); } }}>{status}</button></div>;
            })}{!displayedPairTopics.length && <div className="empty">{workflowText.noTopics}</div>}</div>
            {displayedPairTopics.length > 6 && <button className="topic-list-toggle" onClick={() => setShowAllPairTopics((value) => !value)}>{showAllPairTopics ? pairListText.less : `${pairListText.more} · ${displayedPairTopics.length - 6}`}</button>}

            <div className="actions"><button className="primary" aria-busy={state.running || busy && !connectionAction} disabled={busy || state.running || !state.remote.connected || state.remote.dialogueCompatible === false || !state.pendingTopics.length} onClick={() => void discussAllTopics()}>{state.running || busy && !connectionAction ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}{state.running || busy && !connectionAction ? workflowText.discussing : workflowText.discuss}</button></div>
            {(state.running || busy && !connectionAction) && <PendingStatus language={language}>{workflowText.discussing}</PendingStatus>}
          </section>}

          {activeSection === "people" && <section className="panel portraits-panel" id="people">
            <div className="panel-title"><div><p className="eyebrow">{portraitText.eyebrow}</p><h3>{portraitText.title}</h3></div><UserRound size={20} /></div>
            <p className="portrait-hint">{portraitText.hint}</p>
            {state.portraitsUpdating && <div className="portrait-updating" role="status"><LoaderCircle className="spin" size={17} />{portraitText.updating}</div>}
            {portraits.length > 0 ? <>
              <div className="portrait-person-tabs" role="tablist">{portraits.map((portrait) => <button type="button" role="tab" aria-selected={portrait.personId === selectedPortrait?.personId} className={portrait.personId === selectedPortrait?.personId ? "active" : ""} key={portrait.personId} onClick={() => { setSelectedPortraitId(portrait.personId); setEditingObservationId(""); }}><span>{portrait.label}</span>{portrait.isOwner && <small>{portraitText.you}</small>}<b>{portrait.observations.length}</b></button>)}</div>
              {selectedPortrait && <div className="portrait-sheet">
                <div className="portrait-sheet-heading"><div><h4>{selectedPortrait.label}</h4>{selectedPortrait.relationship && <span>{selectedPortrait.relationship}</span>}</div><small>{selectedPortrait.observations.length}</small></div>
                <div className="portrait-observations">{selectedPortrait.observations.map((observation) => <article className="portrait-observation" key={observation.id}>
                  <div className="portrait-observation-copy"><span className={`portrait-kind ${observation.kind}`}>{portraitText.kinds[observation.kind]}</span>{editingObservationId === observation.id ? <div className="portrait-edit"><textarea autoFocus value={observationDraft} maxLength={500} onChange={(event) => setObservationDraft(event.target.value)} /><div><button className="primary" disabled={!observationDraft.trim()} onClick={() => void savePortraitObservation(selectedPortrait.personId, observation.id)}>{portraitText.save}</button><button className="ghost" onClick={() => { setEditingObservationId(""); setObservationDraft(""); }}><X size={15} />{portraitText.cancel}</button></div></div> : <p>{observation.text}</p>}<small>{observation.sourceType === "conversation" ? `${portraitText.sourceConversation}: ${observation.sourceLabel || "—"}` : portraitText.sourceChat}</small></div>
                  {editingObservationId !== observation.id && <div className="portrait-observation-actions"><button title={portraitText.edit} aria-label={portraitText.edit} onClick={() => { setEditingObservationId(observation.id); setObservationDraft(observation.text); }}><Pencil size={15} /></button><button title={portraitText.remove} aria-label={portraitText.remove} onClick={() => void removePortraitObservation(selectedPortrait.personId, observation.id)}><Trash2 size={15} /></button></div>}
                </article>)}{!selectedPortrait.observations.length && <div className="empty">{portraitText.empty}</div>}</div>
              </div>}
            </> : <div className="empty tall"><UserRound size={28} /><span>{state.contextAnalysis?.status === "analyzing" ? workflowText.analyzing : portraitText.empty}</span></div>}
          </section>}

          {activeSection === "reports" && <section className="panel report-panel" id="reports">
            {reading.saveFailed && <p role="alert">{attentionLabels[language].saveError}</p>}
            <ConversationThreads state={state} language={language} selectedReportId={selectedReportId} onState={setState} activeDictation={activeDictation} reading={reading.reading} onRead={reading.markRead} revealToken={revealToken}
              onDictationBusy={(id, value) => setActiveDictation(current => value ? `report-${id}` : current === `report-${id}` ? "" : current)} />
            <button className="link-button" onClick={() => void api?.openReports()}>{reportsText.files}</button>
          </section>}

          {activeSection === "settings" && <>
            <section className="panel settings-panel" id="settings">
              <div className="panel-title"><div><p className="eyebrow">{t.settings}</p><h3>{deviceText.question}</h3></div><Settings2 size={20} /></div>
              <div className="input-row"><input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={deviceText.placeholder} /><button disabled={!displayName.trim()} onClick={async () => api && setState(await api.setDisplayName(displayName))}>{deviceText.save}</button></div>
              <div className="settings-actions">
                <div className="codex-settings">
                  <label><span>{settingsText.model}</span><select value={state.codexModel} onChange={async (event) => {
                    if (!api) return;
                    const model = event.target.value as CodexModel;
                    const reasoningEffort = supportsCodexConfig(model, state.codexReasoningEffort) ? state.codexReasoningEffort : "medium";
                    setState(await api.setCodexSettings({ model, reasoningEffort }));
                  }}>{CODEX_MODELS.map(model => <option key={model} value={model}>{model === "auto" ? settingsText.automatic : model}</option>)}</select></label>
                  <label><span>{settingsText.effort}</span><select value={state.codexReasoningEffort} onChange={async (event) => api && setState(await api.setCodexSettings({ model: state.codexModel, reasoningEffort: event.target.value as CodexReasoningEffort }))}>{CODEX_REASONING_EFFORTS.filter(effort => supportsCodexConfig(state.codexModel, effort)).map(effort => <option key={effort} value={effort}>{effortNames[effort][language]}</option>)}</select></label>
                  <small>{settingsText.saved}</small>
                </div>
                <div className="codex-settings">
                  <strong>{settingsText.trusted}</strong>
                  <small>{settingsText.trustedInfo}</small>
                  <div className="actions"><button className={state.compute.mode === "off" ? "primary" : "ghost"} disabled={computeBusy} onClick={() => api && void computeAction(() => api.disableComputeChannel())}>{settingsText.off}</button><button className={state.compute.mode === "host" ? "primary" : "ghost"} disabled={computeBusy} onClick={() => api && void computeAction(() => api.configureComputeHost(undefined, state.compute.approvalPolicy))}>{settingsText.host}</button>{state.compute.mode !== "host" && <button className={state.compute.mode === "client" ? "primary" : "ghost"} disabled={computeBusy} onClick={() => api && void computeAction(() => api.requestTrustedComputer())}>{settingsText.client}</button>}</div>
                  {state.compute.mode === "host" && <><label><span>{settingsText.newConnections}</span><select value={state.compute.approvalPolicy} onChange={event => api && void computeAction(() => api.setComputeApprovalPolicy(event.target.value as AppState["compute"]["approvalPolicy"]))}><option value="auto_accept">{settingsText.accept}</option><option value="ask">{settingsText.ask}</option><option value="reject">{settingsText.reject}</option></select></label>{state.compute.requests.map(request => <div className="input-row compact" key={request.id}><span>{settingsText.request} {request.id.slice(0, 8)}</span><button disabled={computeBusy} onClick={() => api && void computeAction(() => api.decideComputeEnrollment(request.id, true))}>{settingsText.allow}</button><button className="ghost" disabled={computeBusy} onClick={() => api && void computeAction(() => api.decideComputeEnrollment(request.id, false))}>{settingsText.deny}</button></div>)}{state.compute.channels.map(channel => <div className="input-row compact" key={channel.channelId}><span>{channel.label} · {channel.enabled ? channel.connected ? settingsText.connected : settingsText.offline : settingsText.disabled}</span>{channel.enabled && <button className="ghost" disabled={computeBusy} onClick={() => api && void computeAction(() => api.revokeComputeChannel(channel.channelId))}>{settingsText.disconnect}</button>}</div>)}</>}
                  {state.compute.mode === "client" && <small>{settingsText.status}: {state.compute.connected ? settingsText.connected : state.compute.enrollmentStatus === "pending" ? settingsText.pendingApproval : settingsText.offline}. {settingsText.pending}: {state.compute.pending}. {settingsText.offlineNormal}</small>}
                </div>
                <button className="ghost" onClick={() => void api?.openDiagnostics().catch(() => setError(loadingText[1]))}>{loadingText[3]}</button>
                <label><input type="checkbox" checked={state.autoStart} onChange={async (e) => api && setState(await api.setAutoStart(e.target.checked))} /> {settingsText.autoStart}</label>
                <UpdateControl update={state.update} version={state.appVersion} language={language} onCheck={async () => api?.checkForUpdates()} onInstall={async () => api?.installUpdate()} />
              </div>
            </section>
            <section className="panel privacy-panel"><div className="panel-title"><div><p className="eyebrow">{t.boundaries}</p><h3>{t.doNotDiscuss}</h3></div><Ban size={20} /></div><div className="input-row compact"><input value={blocked} onChange={(e) => setBlocked(e.target.value)} placeholder={t.blockedPlaceholder} onKeyDown={(e) => e.key === "Enter" && void blockTopic()} /><button onClick={() => void blockTopic()}>{t.block}</button></div>{state.blockedTopics.map((item) => <span className="blocked-chip" key={item}>{item}</span>)}{!state.blockedTopics.length && <p className="muted">{t.noBlocks}</p>}</section>
          </>}
        </div>

        {error && <div className="error"><Bell size={18} />{error}</div>}
      </main>
    </div>
  );
}
