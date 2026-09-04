import { useEffect, useMemo, useState, type SetStateAction } from "react";
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
import { languageNames, translations, type Language } from "./i18n.js";
import { DictationControl } from "./DictationControl.js";
import { PeerVersionControl } from "./PeerVersionControl.js";
import { ConversationUpdates } from "./ConversationUpdates.js";
import { applyConversationUpdate, keepNewerConversations, type ConversationUpdateEvent } from "../core/conversation-updates.js";
import { dictationText } from "./dictation-text.js";
import { appendDictation } from "../core/dictation.js";
import { OWNER_DRAFTS_KEY, parseOwnerDrafts } from "./drafts.js";
import { ReportContinuation } from "./ReportContinuation.js";
import { loadSavedState } from "./load-state.js";
import { shareableTopicBrief, topicKey } from "../core/conversation-quality.js";

const fallback: AppState = {
  owner: "dima",
  onboardingComplete: false,
  identityConfigured: false,
  displayName: "",
  language: "ru",
  autoStart: true,
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
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [topic, setTopic] = useState("");
  const [blocked, setBlocked] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [contextThreads, setContextThreads] = useState<Array<{ id: string; title: string; project: string; source: "codex" | "chatgpt"; cwd?: string; updatedAt?: number }>>([]);
  const [selectedContextProject, setSelectedContextProject] = useState("");
  const [selectedContextId, setSelectedContextId] = useState("");
  const [contextLoading, setContextLoading] = useState(false);
  const [showContextPicker, setShowContextPicker] = useState(false);
  const [counterpartPersonId, setCounterpartPersonId] = useState("");
  const [reviewPersonId, setReviewPersonId] = useState("");
  const [topicFilter, setTopicFilter] = useState<"all" | "review" | "approved">("all");
  const [topicSearch, setTopicSearch] = useState("");
  const [expandedTopicIds, setExpandedTopicIds] = useState<Set<string>>(() => new Set());
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
  const deviceText = {
    ru: { identity: "Участники", local: "этот компьютер", partner: "компьютер партнёра", question: "Как вас называть?", hint: "Это имя увидит только партнёрский агент. Его можно изменить в настройках.", placeholder: "Ваше имя", save: "Сохранить", partnerName: "Агент партнёра", agent: "Агент" },
    en: { identity: "Participants", local: "this computer", partner: "partner computer", question: "What should we call you?", hint: "Only your partner's agent will see this name. You can change it in settings.", placeholder: "Your name", save: "Save", partnerName: "Partner's agent", agent: "Agent" },
    cs: { identity: "Účastníci", local: "tento počítač", partner: "počítač partnera", question: "Jak vám máme říkat?", hint: "Toto jméno uvidí pouze agent partnera. Lze ho změnit v nastavení.", placeholder: "Vaše jméno", save: "Uložit", partnerName: "Agent partnera", agent: "Agent" },
    fr: { identity: "Participants", local: "cet ordinateur", partner: "ordinateur du partenaire", question: "Comment devons-nous vous appeler ?", hint: "Seul l'agent de votre partenaire verra ce nom. Vous pourrez le modifier.", placeholder: "Votre prénom", save: "Enregistrer", partnerName: "Agent du partenaire", agent: "Agent" },
  }[language];
  const contextText = {
    ru: { eyebrow: "БАЗОВЫЙ ЧАТ", title: "Контекст агента", none: "Базовый чат ещё не выбран", explanation: "Приложение берёт из него контекст и примеры вашей манеры общения.", project: "Проект", chat: "Чат", messages: "Ваших реплик", learned: "Запомнено из ответов", synced: "Обновлено", choose: "Выбрать чат", change: "Выбрать другой", refresh: "Проверить новые сообщения", loading: "Читаем список чатов…", apply: "Использовать этот чат", select: "Выберите проект и чат" },
    en: { eyebrow: "BASE CHAT", title: "Agent context", none: "No base chat selected", explanation: "The app uses it for context and examples of your communication style.", project: "Project", chat: "Chat", messages: "Your messages", learned: "Learned from answers", synced: "Updated", choose: "Choose chat", change: "Choose another", refresh: "Check for new messages", loading: "Loading chats…", apply: "Use this chat", select: "Choose a project and chat" },
    cs: { eyebrow: "ZÁKLADNÍ CHAT", title: "Kontext agenta", none: "Základní chat ještě není vybrán", explanation: "Aplikace z něj čerpá kontext a příklady vašeho stylu komunikace.", project: "Projekt", chat: "Chat", messages: "Vašich zpráv", learned: "Zapamatováno z odpovědí", synced: "Aktualizováno", choose: "Vybrat chat", change: "Vybrat jiný", refresh: "Zkontrolovat nové zprávy", loading: "Načítání chatů…", apply: "Použít tento chat", select: "Vyberte projekt a chat" },
    fr: { eyebrow: "CHAT DE BASE", title: "Contexte de l’agent", none: "Aucun chat de base sélectionné", explanation: "L’application l’utilise comme contexte et comme exemples de votre manière de communiquer.", project: "Projet", chat: "Chat", messages: "Vos messages", learned: "Appris de vos réponses", synced: "Mis à jour", choose: "Choisir un chat", change: "En choisir un autre", refresh: "Vérifier les nouveaux messages", loading: "Chargement des chats…", apply: "Utiliser ce chat", select: "Choisissez un projet et un chat" },
  }[language];
  const workflowText = {
    ru: { connection: "СОЕДИНЕНИЕ", link: "Связать два компьютера", who: "К кому из вашего контекста подключается второй компьютер?", choosePerson: "Выберите человека", create: "Создать приглашение", recreate: "Создать новый код", copy: "Копировать код", copied: "Код скопирован", orJoin: "Или вставьте код, созданный на другом компьютере", connect: "Подключиться", connected: "Компьютеры связаны", mapped: "В вашем контексте это", needContext: "Сначала выберите базовый чат и дождитесь определения людей.", openContext: "Открыть контекст", topics: "ТЕМЫ ДЛЯ ЭТОЙ ПАРЫ", topicTitle: "Что обсудят агенты", topicHint: "Одобренные темы от обоих компьютеров собираются здесь. Под названием кратко показано, что произошло и к чему нужен разговор.", localPreview: "Пока показаны разрешённые темы из вашего чата. После подключения сюда добавятся темы с компьютера партнёра.", updatePeer: "Разговоры начнутся, когда на втором компьютере будет установлена эта же новая версия.", noTopics: "Для выбранного человека разрешённых тем пока нет.", addTopic: "Что произошло и что вы хотите понять?", discuss: "Обсудить все темы", discussing: "Агенты обсуждают темы…", analysis: "ЛЮДИ И ТЕМЫ", analysisTitle: "Подготовлено из базового чата", analyzing: "Codex определяет людей и готовит черновики тем…", noAnalysis: "После выгрузки здесь появятся люди и черновики тем.", people: "Люди в контексте", about: "О ком", with: "Обсудить с", approve: "Разрешить обсуждение", cross: "Тема о другом человеке — проверьте адресата особенно внимательно.", unclear: "Адресат определён неуверенно — проверьте перед разрешением." },
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
    ru: "Разговоры начнутся, когда на втором компьютере будет установлена эта же новая версия.",
    en: "Conversations will start once the other computer has the same new version.",
    cs: "Rozhovory začnou, až bude na druhém počítači stejná nová verze.",
    fr: "Les conversations commenceront lorsque l’autre ordinateur aura la même nouvelle version.",
  }[language];
  const pairVersionText = {
    ru: { local: "Этот компьютер", peer: "Компьютер собеседника", current: "Актуальная", updateNeeded: "Нужно обновить", unknown: "Версия ещё не получена", check: "Проверить обновления", checking: "Проверяем обновления…" },
    en: { local: "This computer", peer: "Partner's computer", current: "Up to date", updateNeeded: "Update needed", unknown: "Version not received yet", check: "Check for updates", checking: "Checking for updates…" },
    cs: { local: "Tento počítač", peer: "Počítač partnera", current: "Aktuální", updateNeeded: "Je třeba aktualizovat", unknown: "Verze zatím nebyla přijata", check: "Zkontrolovat aktualizace", checking: "Kontrola aktualizací…" },
    fr: { local: "Cet ordinateur", peer: "Ordinateur du partenaire", current: "À jour", updateNeeded: "Mise à jour requise", unknown: "Version pas encore reçue", check: "Vérifier les mises à jour", checking: "Vérification des mises à jour…" },
  }[language];
  const onboardingText = {
    ru: { eyebrow: "ПЕРВЫЙ ЗАПУСК", title: "Сначала подготовим ваш контекст", lead: "Выберите один чат, который Codex проанализирует как личную основу агента. Другому компьютеру исходные реплики не передаются.", chooseTitle: "1. Выберите базовый чат", chooseHint: "Откроем список ваших проектов и чатов Codex и ChatGPT.", confirmHint: "Этот чат уже был выбран. Можно использовать его снова или выбрать другой.", useSaved: "Использовать этот чат", processingTitle: "Подготавливаем контекст", resumeTitle: "Дополняем сохранённый контекст", export: "Получаем ваши реплики", people: "Определяем людей", topics: "Готовим возможные разговоры", finalizing: "Собираем рекомендации", waiting: "Это может занять несколько минут. Можно оставить приложение открытым.", resumeWaiting: "Уже найденные люди и темы сохранены. Добавляем только то, что изменилось в чате.", reviewTitle: "Выберите разговоры", reviewHint: "Сначала выберите человека. У каждой темы можно увидеть ситуацию, цель и пример первой реплики. Ничего не передаётся без вашего разрешения.", finish: "Подготовить выбранные разговоры", noPeople: "Люди пока не определены. Обновите выгрузку или выберите другой чат." },
    en: { eyebrow: "FIRST RUN", title: "First, prepare your context", lead: "Choose one chat as your agent's private foundation. Raw messages remain on this computer.", chooseTitle: "1. Choose a base chat", chooseHint: "We'll open your Codex projects and chats.", confirmHint: "This chat was selected before. Use it again or choose another.", useSaved: "Use this chat", processingTitle: "Preparing context", resumeTitle: "Updating your saved context", export: "Reading your messages", people: "Identifying people", topics: "Preparing possible conversations", finalizing: "Assembling recommendations", waiting: "This can take a few minutes. You may leave the app open.", resumeWaiting: "Existing people and topics are preserved. Only changes from the chat are being added.", reviewTitle: "Choose conversations", reviewHint: "Choose a person first. Each topic shows the situation, the goal, and a possible opening. Nothing is shared without your approval.", finish: "Prepare selected conversations", noPeople: "No people were identified. Refresh the export or choose another chat." },
    cs: { eyebrow: "PRVNÍ SPUŠTĚNÍ", title: "Nejprve připravíme váš kontext", lead: "Vyberte jeden chat jako soukromý základ agenta. Původní zprávy zůstanou v tomto počítači.", chooseTitle: "1. Vyberte základní chat", chooseHint: "Otevřeme seznam vašich projektů a chatů Codex.", confirmHint: "Tento chat už byl vybrán. Můžete jej použít znovu nebo zvolit jiný.", useSaved: "Použít tento chat", processingTitle: "Připravujeme kontext", resumeTitle: "Doplňujeme uložený kontext", export: "Načítáme vaše zprávy", people: "Rozpoznáváme osoby", topics: "Připravujeme možné rozhovory", finalizing: "Sestavujeme doporučení", waiting: "Může to trvat několik minut. Aplikaci můžete nechat otevřenou.", resumeWaiting: "Nalezené osoby a témata zůstávají zachována. Přidáváme jen změny z chatu.", reviewTitle: "Vyberte rozhovory", reviewHint: "Nejprve vyberte osobu. U každého tématu uvidíte situaci, cíl a možný začátek. Bez vašeho svolení se nic nesdílí.", finish: "Připravit vybrané rozhovory", noPeople: "Nebyly rozpoznány žádné osoby. Obnovte export nebo vyberte jiný chat." },
    fr: { eyebrow: "PREMIER DÉMARRAGE", title: "Préparons d'abord votre contexte", lead: "Choisissez un chat comme base privée de votre agent. Les messages bruts restent sur cet ordinateur.", chooseTitle: "1. Choisissez un chat de base", chooseHint: "Nous ouvrirons vos projets et chats Codex.", confirmHint: "Ce chat a déjà été choisi. Vous pouvez le réutiliser ou en choisir un autre.", useSaved: "Utiliser ce chat", processingTitle: "Préparation du contexte", resumeTitle: "Mise à jour du contexte enregistré", export: "Lecture de vos messages", people: "Identification des personnes", topics: "Préparation des conversations possibles", finalizing: "Assemblage des recommandations", waiting: "Cela peut prendre quelques minutes. Vous pouvez laisser l'application ouverte.", resumeWaiting: "Les personnes et sujets existants sont conservés. Seuls les changements du chat sont ajoutés.", reviewTitle: "Choisissez les conversations", reviewHint: "Choisissez d’abord une personne. Chaque sujet affiche la situation, l’objectif et une ouverture possible. Rien n'est partagé sans votre accord.", finish: "Préparer les conversations choisies", noPeople: "Aucune personne n'a été identifiée. Actualisez l'export ou choisissez un autre chat." },
  }[language];
  const registryText = {
    ru: { topicsFor: "Разговоры с", needReview: "нужно проверить", all: "Все", review: "Проверить", approved: "Выбраны", allowedOf: "выбрано из", allowSafe: "Выбрать безопасные", search: "Найти разговор", collapse: "Свернуть", expand: "Показать подробности", noFilteredTopics: "В этом фильтре тем нет.", context: "О чём речь", goal: "Что хочется понять", opening: "Как может начаться разговор", more: "Показать остальные", less: "Свернуть список" },
    en: { topicsFor: "Conversations with", needReview: "need review", all: "All", review: "Review", approved: "Selected", allowedOf: "selected of", allowSafe: "Select safe topics", search: "Find a conversation", collapse: "Collapse", expand: "Show details", noFilteredTopics: "No topics match this filter.", context: "What this is about", goal: "What to understand", opening: "How the conversation may start", more: "Show the rest", less: "Collapse list" },
    cs: { topicsFor: "Rozhovory s", needReview: "je třeba zkontrolovat", all: "Vše", review: "Zkontrolovat", approved: "Vybráno", allowedOf: "vybráno z", allowSafe: "Vybrat bezpečná témata", search: "Najít rozhovor", collapse: "Sbalit", expand: "Zobrazit podrobnosti", noFilteredTopics: "Tomuto filtru neodpovídají žádná témata.", context: "O čem to je", goal: "Čemu porozumět", opening: "Jak může rozhovor začít", more: "Zobrazit ostatní", less: "Sbalit seznam" },
    fr: { topicsFor: "Conversations avec", needReview: "à vérifier", all: "Tous", review: "Vérifier", approved: "Choisies", allowedOf: "choisies sur", allowSafe: "Choisir les sujets sûrs", search: "Rechercher une conversation", collapse: "Réduire", expand: "Afficher les détails", noFilteredTopics: "Aucun sujet ne correspond à ce filtre.", context: "De quoi s’agit-il", goal: "Ce qu’il faut comprendre", opening: "Comment la conversation peut commencer", more: "Afficher les autres", less: "Réduire la liste" },
  }[language];
  const navigationText = {
    ru: { start: "Первый запуск", connection: "Подключение", context: "Исходный чат и темы", people: "Что знает мой агент", reports: "Итоги разговоров", settings: "Имя и автозапуск", setupTitle: "Подготовка к первому разговору", connectionTitle: "Подключение и темы", contextTitle: "Исходный чат и темы", peopleTitle: "Что знает мой агент", reportsTitle: "Итоги разговоров", settingsTitle: "Имя и автозапуск" },
    en: { start: "First run", connection: "Connection", context: "Source chat and topics", people: "What my agent knows", reports: "Conversation results", settings: "Name and startup", setupTitle: "Prepare the first conversation", connectionTitle: "Connection and topics", contextTitle: "Source chat and topics", peopleTitle: "What my agent knows", reportsTitle: "Conversation results", settingsTitle: "Name and startup" },
    cs: { start: "První spuštění", connection: "Propojení", context: "Zdrojový chat a témata", people: "Co můj agent ví", reports: "Výsledky rozhovorů", settings: "Jméno a spuštění", setupTitle: "Příprava prvního rozhovoru", connectionTitle: "Propojení a témata", contextTitle: "Zdrojový chat a témata", peopleTitle: "Co můj agent ví", reportsTitle: "Výsledky rozhovorů", settingsTitle: "Jméno a spuštění" },
    fr: { start: "Premier démarrage", connection: "Connexion", context: "Chat source et sujets", people: "Ce que sait mon agent", reports: "Résultats des conversations", settings: "Nom et démarrage", setupTitle: "Préparer la première conversation", connectionTitle: "Connexion et sujets", contextTitle: "Chat source et sujets", peopleTitle: "Ce que sait mon agent", reportsTitle: "Résultats des conversations", settingsTitle: "Nom et démarrage" },
  }[language];
  const portraitText = {
    ru: { eyebrow: "ПОРТРЕТЫ ЛЮДЕЙ", title: "Как агент понимает людей", hint: "Портреты строятся из исходного чата и уточняются после завершённых разговоров агентов.", you: "Вы", empty: "Пока о человеке недостаточно информации.", updating: "Дополняем портреты из завершённого разговора…", sourceChat: "Из исходного чата", sourceConversation: "Из разговора", edit: "Исправить", remove: "Удалить", save: "Сохранить", cancel: "Отмена", removeConfirm: "Удалить это суждение из портрета?", kinds: { fact: "Факт", view: "Позиция", preference: "Желание или граница", pattern: "Повторяющаяся реакция", uncertainty: "Неопределённость" } },
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
    ru: { selected: "Выбрана", pending: "Ждёт запуска", active: "Ждём ответ второго агента", complete: "Итог готов" },
    en: { selected: "Selected", pending: "Waiting to start", active: "Waiting for the other agent", complete: "Result ready" },
    cs: { selected: "Vybráno", pending: "Čeká na spuštění", active: "Čeká se na druhého agenta", complete: "Výsledek je připraven" },
    fr: { selected: "Sélectionné", pending: "En attente", active: "En attente de l’autre agent", complete: "Bilan prêt" },
  }[language];
  const reportsText = {
    ru: { empty: "Готовые ответы появятся здесь автоматически.", files: "Показать файлы в папке", messages: "реплик", answer: "Предполагаемая реплика —", conversation: "Прочитать весь разговор", proposed: "Источник темы", comparison: "Что стало понятно", unfinished: "Разговор остановился без естественного завершения. Его можно продолжить своим уточнением." },
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
    if (section !== activeSection && activeDictation && !window.confirm(dictationText[language].leave)) return;
    setActiveSection(section);
    setShowContextPicker(false);
    if (section === "context" && !state.context && !contextThreads.length) void loadContextThreads();
    if (section !== "reports") window.setTimeout(() => document.getElementById(section)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

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
    if (activeSection === "reports" && selectedReportId) document.getElementById(`report-${selectedReportId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [activeSection, selectedReportId]);
  useEffect(() => {
    let active = true;
    let sequence = 0;
    const refreshState = () => {
      const request = ++sequence;
      if (!api) { setLoadFailed(true); return; }
      void loadSavedState(() => api.getState()).then((next) => {
      if (!active || request !== sequence) return;
      setState(next);
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
      if ((raw as { type?: string }).type === "conversations") {
        setState((current) => applyConversationUpdate(current, raw as ConversationUpdateEvent));
        return;
      }
      const versionEvent = raw as { type?: string; peerVersionCheck?: AppState["remote"]["peerVersionCheck"] };
      if (versionEvent.type === "peer-version-check") setState((current) => ({ ...current, remote: { ...current.remote, peerVersionCheck: versionEvent.peerVersionCheck } }));
      const healthEvent = raw as { type?: string; codex?: AppState["codex"]; connected?: boolean };
      if (healthEvent.type === "continuation-updated") refreshState();
      if (healthEvent.type === "health" && healthEvent.codex) setState((current) => ({ ...current, codex: healthEvent.codex!, remote: { ...current.remote, connected: Boolean(healthEvent.connected) } }));
      const event = raw as { type?: string; available?: boolean; version?: string; checking?: boolean; downloading?: boolean; ready?: boolean; error?: string; peerName?: string; peerVersion?: string; peerLastSeenAt?: string; context?: AppState["context"]; analysis?: AppState["contextAnalysis"]; topics?: string[]; pairTopics?: string[]; activeTopics?: string[]; topicSources?: AppState["topicSources"]; reports?: string[]; reportSummaries?: AppState["reportSummaries"]; questions?: AppState["ownerQuestions"]; running?: boolean; syncing?: boolean; updating?: boolean; progress?: number };
      if (event.type === "peer") setState((current) => ({ ...current, remote: { ...current.remote, ...(event.peerName ? { peerName: event.peerName } : {}), ...(event.peerVersion ? { peerVersion: event.peerVersion } : {}), ...(event.peerLastSeenAt ? { peerLastSeenAt: event.peerLastSeenAt } : {}) } }));
      if (event.type === "context" && event.context) setState((current) => ({ ...current, context: event.context }));
      if (event.type === "context-analysis" && event.analysis) {
        setState((current) => ({ ...current, contextAnalysis: event.analysis }));
        setCounterpartPersonId((current) => current || event.analysis?.people[0]?.id || "");
        setReviewPersonId((current) => current && event.analysis?.people.some((person) => person.id === current) ? current : event.analysis?.people[0]?.id || "");
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
    () => state.codex.installed && state.codex.authenticated,
    [state.codex],
  );

  async function addTopic() {
    if (!topic.trim() || activeDictation) return;
    setError("");
    try {
      if (api) setState(await api.addTopic(topic));
      else setState((current) => ({ ...current, pendingTopics: [...current.pendingTopics, topic] }));
      setTopic("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

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
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function answerOwnerQuestion(id: string, disposition: "answer" | "unknown" | "decline") {
    if (!api || activeDictation || answeringQuestionId) return;
    setAnsweringQuestionId(id); setError("");
    try {
      const answer = ownerAnswers[id]?.trim() || "";
      setState(await api.answerOwnerQuestion({ id, disposition, answer }));
      setOwnerAnswers((current) => { const next = { ...current }; delete next[id]; return next; });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setAnsweringQuestionId(""); }
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
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setContextLoading(false); }
  }

  function contextPicker() {
    if (contextLoading && !contextThreads.length) return <span>{contextText.loading}</span>;
    const projects = [...new Set(contextThreads.map((thread) => thread.project))].sort((left, right) => left.localeCompare(right, language));
    const chats = contextThreads.filter((thread) => thread.project === selectedContextProject);
    return <>
      <select aria-label={contextText.project} value={selectedContextProject} onChange={(event) => {
        const project = event.target.value;
        setSelectedContextProject(project);
        setSelectedContextId(contextThreads.find((thread) => thread.project === project)?.id ?? "");
      }}><option value="">{contextText.project}</option>{projects.map((project) => <option value={project} key={project}>{project}</option>)}</select>
      <select aria-label={contextText.chat} value={selectedContextId} onChange={(event) => setSelectedContextId(event.target.value)}><option value="">{contextText.chat}</option>{chats.map((thread) => <option value={thread.id} key={thread.id}>{thread.title}</option>)}</select>
      <button className="primary" disabled={!selectedContextId || contextLoading} onClick={() => void selectContext()}>{contextText.apply}</button>
    </>;
  }

  async function selectContext() {
    if (!api || !selectedContextId) return;
    setContextLoading(true); setError("");
    setState((current) => ({ ...current, contextAnalysis: undefined }));
    try { setState(await api.selectContextThread(selectedContextId)); setShowContextPicker(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setContextLoading(false); }
  }

  async function confirmSavedContext() {
    if (!api || !state.context?.id || contextLoading) return;
    setContextLoading(true); setError("");
    setState((current) => ({ ...current, context: current.context ? { ...current.context, status: "syncing" } : current.context, contextAnalysis: undefined }));
    try { setState(await api.selectContextThread(state.context.id)); setShowContextPicker(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setContextLoading(false); }
  }

  async function refreshContextNow() {
    if (!api) return;
    setContextLoading(true); setError("");
    try { setState(await api.refreshContextNow()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setContextLoading(false); }
  }

  async function createInvite() {
    if (!api || !selectedPairPersonId) return;
    setBusy(true); setError(""); setInviteCopied(false);
    try { setState(await api.createPair(selectedPairPersonId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function connectWithInvite() {
    if (!api || !selectedPairPersonId || !inviteCode.trim()) return;
    setBusy(true); setError("");
    try { setState(await api.joinPair(inviteCode, selectedPairPersonId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
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
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setVersionCheckBusy(false); }
  }

  async function updateContextTopic(topicId: string, update: { aboutPersonIds?: string[]; discussWithPersonId?: string; approved?: boolean }) {
    if (!api) return;
    setError("");
    try { setState(await api.updateContextTopic({ topicId, ...update })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function savePortraitObservation(personId: string, observationId: string) {
    if (!api || !observationDraft.trim()) return;
    setError("");
    try {
      setState(await api.updatePortraitObservation({ personId, observationId, text: observationDraft }));
      setEditingObservationId("");
      setObservationDraft("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function removePortraitObservation(personId: string, observationId: string) {
    if (!api || !window.confirm(portraitText.removeConfirm)) return;
    setError("");
    try { setState(await api.updatePortraitObservation({ personId, observationId, remove: true })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function completeOnboarding(personId: string) {
    if (!api) return;
    setError("");
    try { setState(await api.completeOnboarding(personId)); setCounterpartPersonId(personId); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function approveSafeTopics(personId: string) {
    if (!api || !state.contextAnalysis) return;
    const topicIds = state.contextAnalysis.topics.filter((item) => item.discussWithPersonId === personId && item.sensitivity === "direct").map((item) => item.id);
    if (!topicIds.length) return;
    setError("");
    try { setState(await api.updateContextTopics({ topicIds, approved: true })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
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
    const topicPeople = state.contextAnalysis.people.filter((person) => state.contextAnalysis!.topics.some((topic) => topic.discussWithPersonId === person.id));
    if (!topicPeople.length) return <div className="empty">{registryText.noFilteredTopics}</div>;
    const selectedPerson = topicPeople.find((person) => person.id === reviewPersonId)
      ?? topicPeople.find((person) => person.id === state.preferredCounterpartPersonId)
      ?? topicPeople.find((person) => person.id === state.remote.counterpartPersonId)
      ?? topicPeople[0];
    const allForPerson = state.contextAnalysis.topics.filter((item) => item.discussWithPersonId === selectedPerson.id);
    const selectedPersonTopics = allForPerson
      .filter((item) => topicFilter === "all" || topicFilter === "approved" && item.approved || topicFilter === "review" && item.sensitivity !== "direct")
      .filter((item) => !topicSearch.trim() || `${item.title} ${item.reason}`.toLocaleLowerCase(language).includes(topicSearch.trim().toLocaleLowerCase(language)))
      .sort((left, right) => Number(left.sensitivity === "direct") - Number(right.sensitivity === "direct") || left.title.localeCompare(right.title, language));
    const visibleTopics = showAllReviewTopics || topicSearch.trim() || topicFilter !== "all" ? selectedPersonTopics : selectedPersonTopics.slice(0, 6);
    const reviewCount = allForPerson.filter((item) => item.sensitivity !== "direct").length;
    const approvedCount = allForPerson.filter((item) => item.approved).length;
    return <div className="topic-registry">
      <div className="person-tabs" role="tablist">{topicPeople.map((person) => {
        const count = state.contextAnalysis!.topics.filter((item) => item.discussWithPersonId === person.id).length;
        return <button type="button" role="tab" aria-selected={person.id === selectedPerson.id} className={person.id === selectedPerson.id ? "active" : ""} key={person.id} onClick={() => { setReviewPersonId(person.id); setShowAllReviewTopics(false); }}>{personLabel(person.id)} <span>{count}</span></button>;
      })}</div>
      <div className="registry-heading"><div><h4>{registryText.topicsFor}: {personLabel(selectedPerson.id)}</h4><p>{allForPerson.length} · {reviewCount} {registryText.needReview}</p></div><div className="registry-controls"><input value={topicSearch} onChange={(event) => setTopicSearch(event.target.value)} placeholder={registryText.search} aria-label={registryText.search} /><div className="registry-filters"><button className={topicFilter === "all" ? "active" : ""} onClick={() => setTopicFilter("all")}>{registryText.all}</button><button className={topicFilter === "review" ? "active" : ""} onClick={() => setTopicFilter("review")}>{registryText.review}</button><button className={topicFilter === "approved" ? "active" : ""} onClick={() => setTopicFilter("approved")}>{registryText.approved}</button></div></div></div>
      <div className="registry-toolbar"><span>{approvedCount} {registryText.allowedOf} {allForPerson.length}</span><button className="ghost" onClick={() => void approveSafeTopics(selectedPerson.id)}>{registryText.allowSafe}</button></div>
      <div className="topic-rows">{visibleTopics.map((item) => {
        const expanded = expandedTopicIds.has(item.id);
        const about = item.aboutPersonIds.map(personLabel).join(", ") || "—";
        const brief = shareableTopicBrief(item);
        return <div className={`topic-row ${item.sensitivity} ${expanded ? "expanded" : ""}`} key={item.id}>
          <div className="topic-row-main"><label className="topic-approval"><input type="checkbox" checked={item.approved} onChange={(event) => void updateContextTopic(item.id, { approved: event.target.checked })} /><span className="topic-approval-copy"><strong>{item.title}</strong>{brief?.context && <small>{brief.context}</small>}</span></label><span className="topic-about">{workflowText.about}: {about}{item.sensitivity !== "direct" ? ` · ${registryText.review}` : ""}</span><button className="topic-expand" aria-label={expanded ? registryText.collapse : registryText.expand} aria-expanded={expanded} onClick={() => toggleTopicDetails(item.id)}><ChevronDown size={17} /></button></div>
          {expanded && <div className="topic-row-detail"><div className="topic-brief-grid">{brief?.context && <div><small>{registryText.context}</small><p>{brief.context}</p></div>}{brief?.goal && <div><small>{registryText.goal}</small><p>{brief.goal}</p></div>}{brief?.openingQuestion && <div className="topic-opening"><small>{registryText.opening}</small><p>«{brief.openingQuestion}»</p></div>}</div><div className="route-fields"><label>{workflowText.about}<select value={item.aboutPersonIds[0] || ""} onChange={(event) => void updateContextTopic(item.id, { aboutPersonIds: [event.target.value] })}>{state.contextAnalysis!.people.map((person) => <option value={person.id} key={person.id}>{personLabel(person.id)}</option>)}</select></label><label>{workflowText.with}<select value={item.discussWithPersonId} onChange={(event) => void updateContextTopic(item.id, { discussWithPersonId: event.target.value })}>{state.contextAnalysis!.people.map((person) => <option value={person.id} key={person.id}>{personLabel(person.id)}</option>)}</select></label></div>{item.sensitivity === "cross_person" && <small className="route-warning">{workflowText.cross}</small>}{item.sensitivity === "unclear" && <small className="route-warning">{workflowText.unclear}</small>}</div>}
        </div>;
      })}{!selectedPersonTopics.length && <div className="empty">{registryText.noFilteredTopics}</div>}</div>
      {!topicSearch.trim() && topicFilter === "all" && selectedPersonTopics.length > 6 && <button className="topic-list-toggle" onClick={() => setShowAllReviewTopics((value) => !value)}>{showAllReviewTopics ? registryText.less : `${registryText.more} · ${selectedPersonTopics.length - 6}`}</button>}
      {!state.onboardingComplete && <div className="onboarding-finish"><button className="primary" disabled={!approvedCount} onClick={() => void completeOnboarding(selectedPerson.id)}>{onboardingText.finish}: {personLabel(selectedPerson.id)}</button></div>}
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
  if (!loaded) return <div className="startup-status" role="status"><h1>Family Bridge</h1><p>{loadFailed ? loadingText[1] : loadingText[0]}</p>{loadFailed && <button onClick={() => { setLoadFailed(false); setReload((value) => value + 1); }}>{loadingText[2]}</button>}</div>;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><MessageCircleHeart size={25} /><span>Family Bridge</span></div>
        <nav>
          <button className={activeSection === "overview" ? "active" : ""} onClick={() => goTo("overview")}><Activity size={18} /><span>{state.onboardingComplete ? navigationText.connection : navigationText.start}</span>{state.ownerQuestions.length > 0 && <b className="nav-badge">{state.ownerQuestions.length}</b>}</button>
          <button className={activeSection === "context" ? "active" : ""} onClick={() => goTo("context")}><BookHeart size={18} />{navigationText.context}</button>
          <button className={activeSection === "people" ? "active" : ""} onClick={() => goTo("people")}><UserRound size={18} />{navigationText.people}</button>
          <button className={activeSection === "reports" ? "active" : ""} onClick={() => goTo("reports")}><ScrollText size={18} />{navigationText.reports}</button>
          <button className={activeSection === "settings" ? "active" : ""} onClick={() => goTo("settings")}><Settings2 size={18} />{navigationText.settings}</button>
        </nav>
        <div className="sidebar-status">
          <span className={health ? "status-dot online" : "status-dot"} />
          <div><strong>{health ? t.ready : t.setup}</strong><small>Family Bridge v{state.appVersion}</small><small>{state.codex.version}</small></div>
        </div>
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
            <button className="primary" disabled={!ownerAnswers[item.id]?.trim() || Boolean(answeringQuestionId) || Boolean(activeDictation)} onClick={() => void answerOwnerQuestion(item.id, "answer")}>{answeringQuestionId === item.id ? ownerQuestionText.processing : ownerQuestionText.answer}</button>
            <button className="ghost" disabled={Boolean(answeringQuestionId) || Boolean(activeDictation)} onClick={() => void answerOwnerQuestion(item.id, "unknown")}>{ownerQuestionText.unknown}</button>
            <button className="ghost" disabled={Boolean(answeringQuestionId) || Boolean(activeDictation)} onClick={() => void answerOwnerQuestion(item.id, "decline")}>{ownerQuestionText.decline}</button>
          </div>
        </section>)}

        {activeSection === "overview" && !state.onboardingComplete && <section className="panel onboarding-panel">
          {state.contextAnalysis?.status !== "ready" && <div className="onboarding-intro"><p>{onboardingText.lead}</p></div>}
          <div className="onboarding-steps"><div className={state.context && state.context.status !== "confirmation" ? "done" : "active"}><span>{state.context && state.context.status !== "confirmation" ? <Check size={16} /> : "1"}</span>{onboardingText.chooseTitle}</div><div className={state.contextAnalysis?.status === "ready" ? "done" : state.context && state.context.status !== "confirmation" ? "active" : ""}><span>{state.contextAnalysis?.status === "ready" ? <Check size={16} /> : "2"}</span>{onboardingText.processingTitle}</div><div className={state.contextAnalysis?.status === "ready" ? "active" : ""}><span>3</span>{onboardingText.reviewTitle}</div></div>
          {!state.context && <div className="onboarding-stage"><h3>{onboardingText.chooseTitle}</h3><p>{onboardingText.chooseHint}</p><button className="primary" disabled={contextLoading} onClick={() => void loadContextThreads()}>{contextText.choose}</button></div>}
          {state.context?.status === "confirmation" && <div className="onboarding-stage context-confirmation"><h3>{onboardingText.chooseTitle}</h3><p>{onboardingText.confirmHint}</p><div className="processing-source"><strong>{state.context.project} · {state.context.title}</strong><small>{state.context.messageCount ?? 0} {contextText.messages.toLowerCase()}</small></div><div className="actions"><button className="primary" disabled={contextLoading} onClick={() => void confirmSavedContext()}>{onboardingText.useSaved}</button><button className="ghost" disabled={contextLoading} onClick={() => void loadContextThreads()}>{contextText.change}</button></div></div>}
          {showContextPicker && (!state.context || state.context.status === "confirmation") && <div className="context-picker onboarding-picker">{contextPicker()}</div>}
          {state.context && state.context.status !== "confirmation" && state.contextAnalysis?.status !== "ready" && (() => { if (state.context?.status === "error" || state.contextAnalysis?.status === "error") return <div className="onboarding-stage" role="alert"><p>{state.contextAnalysis?.error || state.context?.error}</p><button onClick={() => void api?.refreshContextNow().then(setState).catch(() => setError(loadingText[1]))}>{loadingText[2]}</button><button className="ghost" onClick={() => void loadContextThreads()}>{contextText.change}</button></div>; const hasSavedAnalysis = Boolean(state.contextAnalysis?.people.length || state.contextAnalysis?.topics.length); const finalizing = state.contextAnalysis?.progress?.stage === "consolidating"; return <div className="onboarding-stage processing-stage"><h3>{hasSavedAnalysis ? onboardingText.resumeTitle : onboardingText.processingTitle}</h3><div className="processing-source"><strong>{state.context.project} · {state.context.title}</strong><small>{state.context.messageCount ?? 0} {contextText.messages.toLowerCase()}</small></div><div className="processing-list"><div className={state.context.status === "ready" ? "done" : "active"}>{state.context.status === "ready" ? <Check size={18} /> : <LoaderCircle className="spin" size={18} />}<span>{onboardingText.export}</span></div><div className={hasSavedAnalysis || finalizing ? "done" : state.contextAnalysis ? "active" : "waiting"}>{hasSavedAnalysis || finalizing ? <Check size={18} /> : <LoaderCircle className={state.contextAnalysis ? "spin" : ""} size={18} />}<span>{onboardingText.people}</span></div><div className={state.contextAnalysis ? "active" : "waiting"}><LoaderCircle className={state.contextAnalysis ? "spin" : ""} size={18} /><span>{finalizing ? onboardingText.finalizing : onboardingText.topics}{state.contextAnalysis?.progress && !finalizing ? ` · ${state.contextAnalysis.progress.current}/${Math.max(1, state.contextAnalysis.progress.total - 1)}` : ""}</span></div></div><p className="muted">{hasSavedAnalysis ? onboardingText.resumeWaiting : onboardingText.waiting}</p></div>; })()}
          {state.contextAnalysis?.status === "ready" && <div className="onboarding-stage review-stage"><div className="review-intro"><div><h3>{onboardingText.reviewTitle}</h3><p>{onboardingText.reviewHint}</p></div><button className="ghost" onClick={() => void loadContextThreads()}>{contextText.change}</button></div>{showContextPicker && <div className="context-picker onboarding-picker">{contextPicker()}</div>}{topicRegistry()}</div>}
        </section>}

        {activeSection === "overview" && state.onboardingComplete && <section className="hero-card">
          <div>
            <span className="hero-icon"><ShieldCheck /></span>
            <p className="eyebrow">{t.state}</p>
            <h2>{busy ? t.talking : t.waiting}</h2>
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
          {state.identityConfigured && !state.remote.connected && <>
            {state.contextAnalysis?.people.length ? <>
              <label className="counterpart-select"><span>{workflowText.who}</span><select value={selectedPairPersonId || ""} onChange={(e) => setCounterpartPersonId(e.target.value)}><option value="">{workflowText.choosePerson}</option>{state.contextAnalysis.people.map((person) => <option key={person.id} value={person.id}>{personLabel(person.id)}</option>)}</select></label>
              <div className="pair-actions"><button className="primary" disabled={!selectedPairPersonId || busy} onClick={() => void createInvite()}>{state.remote.invite ? workflowText.recreate : workflowText.create}</button></div>
              {state.remote.invite && <div className="invite-box"><p>{t.shareCode}</p><textarea readOnly value={state.remote.invite} onFocus={(e) => e.currentTarget.select()} /><button className="ghost" onClick={() => void copyInvite()}>{inviteCopied ? workflowText.copied : workflowText.copy}</button></div>}
              <div className="join-box"><span>{workflowText.orJoin}</span><div className="input-row"><input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder={t.pasteInvite}/><button disabled={!selectedPairPersonId || !inviteCode.trim() || busy} onClick={() => void connectWithInvite()}>{workflowText.connect}</button></div></div>
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
            <div className="actions"><button className="ghost" disabled={contextLoading} onClick={() => void loadContextThreads()}>{state.context ? contextText.change : contextText.choose}</button>{state.context && <button className="ghost" disabled={contextLoading || state.contextSyncing} onClick={() => void refreshContextNow()}>{contextText.refresh}</button>}</div>
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
            <div className="topic-list">{visiblePairTopics.map((item) => {
              const report = state.reportSummaries.find((candidate) => candidate.topic === item);
              const active = state.activeTopics.includes(item);
              const pending = state.pendingTopics.includes(item);
              const brief = topicBrief(item);
              const status = active ? topicStatusText.active : report ? topicStatusText.complete : pending ? topicStatusText.pending : topicStatusText.selected;
              return <div className="topic pair-topic" key={item}><div className="topic-copy"><span>{item}</span>{(brief?.context || brief?.goal) && <p className="topic-context">{brief.context || brief.goal}</p>}<small>{topicSourceLabel(item)}</small></div><button className={`topic-state ${report ? "complete" : active ? "active" : ""}`} disabled={!report} onClick={() => { if (report) { setSelectedReportId(report.id); goTo("reports"); } }}>{status}</button></div>;
            })}{!displayedPairTopics.length && <div className="empty">{workflowText.noTopics}</div>}</div>
            {displayedPairTopics.length > 6 && <button className="topic-list-toggle" onClick={() => setShowAllPairTopics((value) => !value)}>{showAllPairTopics ? pairListText.less : `${pairListText.more} · ${displayedPairTopics.length - 6}`}</button>}
            <div className="input-row"><input aria-label={workflowText.addTopic} disabled={!state.remote.counterpartPersonId} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={workflowText.addTopic} onKeyDown={(e) => e.key === "Enter" && void addTopic()} /><button disabled={!state.remote.counterpartPersonId || !topic.trim() || Boolean(activeDictation)} onClick={() => void addTopic()}>{t.add}</button></div>
            <DictationControl language={language} disabled={!state.remote.counterpartPersonId || Boolean(activeDictation && activeDictation !== "new-topic")} onText={(text) => setTopic((current) => appendDictation(current, text))} onBusyChange={(value) => setActiveDictation((current) => value ? "new-topic" : current === "new-topic" ? "" : current)} />
            <div className="actions"><button className="primary" disabled={busy || !state.remote.connected || state.remote.dialogueCompatible === false || !state.pendingTopics.length} onClick={() => void discussAllTopics()}><Sparkles size={17} />{busy ? workflowText.discussing : workflowText.discuss}</button></div>
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
            <div className="panel-title"><div><p className="eyebrow">{t.result}</p><h3>{t.latest}</h3></div><ScrollText size={20} /></div>
            {!state.reportSummaries.length && <div className="empty tall"><ScrollText size={28} /><span>{reportsText.empty}</span></div>}
            <div className="report-cards">{state.reportSummaries.map((report) => <article className={`report-card ${selectedReportId === report.id ? "selected-report" : ""}`} id={`report-${report.id}`} key={report.id}>
              <div className="report-heading"><div><strong>{report.topic}</strong>{topicBrief(report.topic)?.context && <p>{topicBrief(report.topic)?.context}</p>}</div><div className={`report-status ${report.completionState === "needs_follow_up" ? "unfinished" : ""}`}><span>{report.completionState === "needs_follow_up" ? dialogueText.unfinished : dialogueText.completed}</span><time>{report.completedAt ? new Date(report.completedAt).toLocaleString(language) : ""}</time></div></div>
              {report.parentReportId && <button className="link-button" onClick={() => setSelectedReportId(report.parentReportId!)}>{({ ru: "Продолжение · Показать предыдущий итог", en: "Continuation · Show previous result", cs: "Pokračování · Zobrazit předchozí závěr", fr: "Suite · Voir le résultat précédent" })[language]}</button>}
              <div className="report-source">{reportsText.proposed}: <strong>{report.proposedBy.join(" + ")}</strong></div>
              {report.completionState === "needs_follow_up" && <div className="notice">{reportsText.unfinished}</div>}
              <section className="report-transcript"><div className="report-dialogue-heading"><strong>{dialogueText.conversation}</strong><small>{report.messageCount} {reportsText.messages}</small></div><div role="log" aria-label={dialogueText.conversation}>{report.messages.map((message, index) => <div className={`transcript-message ${message.local ? "local" : "peer"}`} key={`${report.id}-${index}`}><strong>{message.speaker}</strong><p>{message.text}</p></div>)}</div></section>
              <ConversationUpdates reportId={report.id} state={state} language={language} onOpenReport={setSelectedReportId} />
              {report.comparison && <div className="report-comparison"><small>{dialogueText.result}</small><p>{report.comparison}</p></div>}
              {(report.localPosition || report.peerPosition) && <details className="report-position-details"><summary>{dialogueText.positions}</summary><div className="report-positions">{report.localPosition && <div className="report-answer local"><small>{reportsText.answer} {state.displayName || deviceText.local}</small><p>{report.localPosition}</p></div>}{report.peerPosition && <div className="report-answer peer"><small>{reportsText.answer} {state.remote.peerName || deviceText.partner}</small><p>{report.peerPosition}</p></div>}</div></details>}
              <ReportContinuation reportId={report.id} state={state} language={language} onState={setState} dictationBusy={Boolean(activeDictation)} onDictationBusy={(value) => setActiveDictation((current) => value ? `report-${report.id}` : current === `report-${report.id}` ? "" : current)} />
            </article>)}</div>
            <button className="link-button" onClick={() => void api?.openReports()}>{reportsText.files}</button>
          </section>}

          {activeSection === "settings" && <>
            <section className="panel settings-panel" id="settings">
              <div className="panel-title"><div><p className="eyebrow">{t.settings}</p><h3>{deviceText.question}</h3></div><Settings2 size={20} /></div>
              <div className="input-row"><input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={deviceText.placeholder} /><button disabled={!displayName.trim()} onClick={async () => api && setState(await api.setDisplayName(displayName))}>{deviceText.save}</button></div>
              <div className="settings-actions">
                <button className="ghost" onClick={() => void api?.openDiagnostics().catch(() => setError(loadingText[1]))}>{loadingText[3]}</button>
                <label><input type="checkbox" checked={state.autoStart} onChange={async (e) => api && setState(await api.setAutoStart(e.target.checked))} /> Автозапуск приложения</label>
                <div className="update-card" aria-live="polite">
                  {state.update.checking && <div className="update-status"><LoaderCircle className="spin" size={18} /><div><strong>Проверяем обновления</strong><small>Обычно это занимает несколько секунд.</small></div></div>}
                  {state.update.downloading && <div className="update-download"><div className="update-status"><LoaderCircle className="spin" size={18} /><div><strong>Скачиваем версию {state.update.version}</strong><small>Приложение продолжает работать. После загрузки предложим перезапуск.</small></div><b>{state.update.progress ?? 0}%</b></div><progress max="100" value={state.update.progress ?? 0} /></div>}
                  {state.update.ready && <div className="update-status update-ready"><Check size={18} /><div><strong>Версия {state.update.version} скачана</strong><small>Осталось перезапустить приложение — ваши данные сохранятся.</small></div><button onClick={() => void api?.installUpdate()}>Перезапустить и установить</button></div>}
                  {state.update.error && <div className="update-status update-failed"><Bell size={18} /><div><strong>Не удалось обновиться</strong><small>{state.update.error}</small></div><button onClick={() => void api?.checkForUpdates()}>Повторить</button></div>}
                  {!state.update.checking && !state.update.downloading && !state.update.ready && !state.update.error && <div className="update-status"><Check size={18} /><div><strong>Установлена последняя версия</strong><small>Новые версии скачиваются автоматически в фоне.</small></div><button onClick={() => void api?.checkForUpdates()}>Проверить сейчас</button></div>}
                </div>
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
