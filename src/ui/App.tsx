import { useEffect, useMemo, useState } from "react";
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
  ScrollText,
  Settings2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { AppState } from "../global.js";
import { languageNames, translations, type Language } from "./i18n.js";

const fallback: AppState = {
  owner: "dima",
  onboardingComplete: false,
  identityConfigured: false,
  displayName: "",
  language: "ru",
  autoStart: true,
  pendingTopics: ["Как сделать бытовые договорённости спокойнее"],
  pairTopics: ["Как сделать бытовые договорённости спокойнее"],
  activeTopics: [],
  blockedTopics: [],
  reports: [],
  reportSummaries: [],
  ownerQuestions: [],
  running: false,
  contextSyncing: false,
  contextSyncProgress: 0,
  codex: { installed: true, authenticated: true, version: "preview mode" },
  remote: { configured: false, connected: false },
  memory: { configured: false, messageCount: 0 },
  update: { available: false, downloading: false },
};

type SectionId = "overview" | "context" | "reports" | "settings";

export function App() {
  const [state, setState] = useState<AppState>(fallback);
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
  const [ownerAnswers, setOwnerAnswers] = useState<Record<string, string>>({});
  const [answeringQuestionId, setAnsweringQuestionId] = useState("");
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
    ru: { eyebrow: "БАЗОВЫЙ ЧАТ", title: "Контекст агента", none: "Базовый чат ещё не выбран", explanation: "Приложение берёт из него контекст и примеры вашей манеры общения.", project: "Проект", chat: "Чат", messages: "Ваших реплик", synced: "Обновлено", choose: "Выбрать чат", change: "Выбрать другой", refresh: "Проверить новые сообщения", loading: "Читаем список чатов…", apply: "Использовать этот чат", select: "Выберите проект и чат" },
    en: { eyebrow: "BASE CHAT", title: "Agent context", none: "No base chat selected", explanation: "The app uses it for context and examples of your communication style.", project: "Project", chat: "Chat", messages: "Your messages", synced: "Updated", choose: "Choose chat", change: "Choose another", refresh: "Check for new messages", loading: "Loading chats…", apply: "Use this chat", select: "Choose a project and chat" },
    cs: { eyebrow: "ZÁKLADNÍ CHAT", title: "Kontext agenta", none: "Základní chat ještě není vybrán", explanation: "Aplikace z něj čerpá kontext a příklady vašeho stylu komunikace.", project: "Projekt", chat: "Chat", messages: "Vašich zpráv", synced: "Aktualizováno", choose: "Vybrat chat", change: "Vybrat jiný", refresh: "Zkontrolovat nové zprávy", loading: "Načítání chatů…", apply: "Použít tento chat", select: "Vyberte projekt a chat" },
    fr: { eyebrow: "CHAT DE BASE", title: "Contexte de l’agent", none: "Aucun chat de base sélectionné", explanation: "L’application l’utilise comme contexte et comme exemples de votre manière de communiquer.", project: "Projet", chat: "Chat", messages: "Vos messages", synced: "Mis à jour", choose: "Choisir un chat", change: "En choisir un autre", refresh: "Vérifier les nouveaux messages", loading: "Chargement des chats…", apply: "Utiliser ce chat", select: "Choisissez un projet et un chat" },
  }[language];
  const workflowText = {
    ru: { connection: "СОЕДИНЕНИЕ", link: "Связать два компьютера", who: "К кому из вашего контекста подключается второй компьютер?", choosePerson: "Выберите человека", create: "Создать приглашение", recreate: "Создать новый код", copy: "Копировать код", copied: "Код скопирован", orJoin: "Или вставьте код, созданный на другом компьютере", connect: "Подключиться", connected: "Компьютеры связаны", mapped: "В вашем контексте это", needContext: "Сначала выберите базовый чат и дождитесь определения людей.", openContext: "Открыть контекст", topics: "ТЕМЫ ДЛЯ ЭТОЙ ПАРЫ", topicTitle: "Что обсудят агенты", topicHint: "Одобренные темы от обоих компьютеров собираются здесь. Каждая тема обсуждается в отдельном диалоге.", localPreview: "Пока показаны разрешённые темы из вашего чата. После подключения сюда добавятся темы с компьютера партнёра.", noTopics: "Для выбранного человека разрешённых тем пока нет.", addTopic: "Добавить тему для этой пары", discuss: "Обсудить все темы", discussing: "Агенты обсуждают темы…", analysis: "ЛЮДИ И ТЕМЫ", analysisTitle: "Подготовлено из базового чата", analyzing: "Codex определяет людей и готовит черновики тем…", noAnalysis: "После выгрузки здесь появятся люди и черновики тем.", people: "Люди в контексте", about: "О ком", with: "Обсудить с", approve: "Разрешить обсуждение", cross: "Тема о другом человеке — проверьте адресата особенно внимательно.", unclear: "Адресат определён неуверенно — проверьте перед разрешением." },
    en: { connection: "CONNECTION", link: "Link two computers", who: "Who in your context does the other computer belong to?", choosePerson: "Choose a person", create: "Create invitation", recreate: "Create a new code", copy: "Copy code", copied: "Code copied", orJoin: "Or paste a code created on the other computer", connect: "Connect", connected: "Computers linked", mapped: "In your context this is", needContext: "First choose a base chat and wait for people to be identified.", openContext: "Open context", topics: "TOPICS FOR THIS PAIR", topicTitle: "What the agents will discuss", topicHint: "Approved topics from both computers gather here. Each topic gets its own conversation.", localPreview: "These are the approved topics from your chat. Topics from your partner's computer will be added after connection.", noTopics: "No approved topics for the selected person yet.", addTopic: "Add a topic for this pair", discuss: "Discuss all topics", discussing: "Agents are discussing topics…", analysis: "PEOPLE AND TOPICS", analysisTitle: "Prepared from the base chat", analyzing: "Codex is identifying people and preparing topic drafts…", noAnalysis: "People and topic drafts will appear here after export.", people: "People in context", about: "About", with: "Discuss with", approve: "Allow discussion", cross: "This topic is about someone else — verify the recipient carefully.", unclear: "The recipient is uncertain — verify before allowing." },
    cs: { connection: "PROPOJENÍ", link: "Propojit dva počítače", who: "Komu ve vašem kontextu patří druhý počítač?", choosePerson: "Vyberte osobu", create: "Vytvořit pozvánku", recreate: "Vytvořit nový kód", copy: "Kopírovat kód", copied: "Kód zkopírován", orJoin: "Nebo vložte kód vytvořený na druhém počítači", connect: "Připojit", connected: "Počítače jsou propojeny", mapped: "Ve vašem kontextu je to", needContext: "Nejprve vyberte základní chat a počkejte na určení osob.", openContext: "Otevřít kontext", topics: "TÉMATA PRO TUTO DVOJICI", topicTitle: "O čem budou agenti mluvit", topicHint: "Schválená témata z obou počítačů se shromažďují zde. Každé téma má vlastní rozhovor.", localPreview: "Zatím jsou zobrazená schválená témata z vašeho chatu. Po propojení se přidají témata z počítače partnera.", noTopics: "Pro vybranou osobu zatím nejsou schválená témata.", addTopic: "Přidat téma pro tuto dvojici", discuss: "Probrat všechna témata", discussing: "Agenti probírají témata…", analysis: "LIDÉ A TÉMATA", analysisTitle: "Připraveno ze základního chatu", analyzing: "Codex rozpoznává osoby a připravuje návrhy témat…", noAnalysis: "Po exportu se zde zobrazí lidé a návrhy témat.", people: "Lidé v kontextu", about: "O kom", with: "Probrat s", approve: "Povolit diskusi", cross: "Téma je o jiné osobě — pečlivě ověřte adresáta.", unclear: "Adresát je nejistý — před povolením jej ověřte." },
    fr: { connection: "CONNEXION", link: "Relier deux ordinateurs", who: "À quelle personne de votre contexte correspond l’autre ordinateur ?", choosePerson: "Choisir une personne", create: "Créer une invitation", recreate: "Créer un nouveau code", copy: "Copier le code", copied: "Code copié", orJoin: "Ou collez un code créé sur l’autre ordinateur", connect: "Connecter", connected: "Ordinateurs reliés", mapped: "Dans votre contexte, il s’agit de", needContext: "Choisissez d’abord un chat de base et attendez l’identification des personnes.", openContext: "Ouvrir le contexte", topics: "SUJETS POUR CETTE PAIRE", topicTitle: "Ce que les agents vont discuter", topicHint: "Les sujets approuvés des deux ordinateurs sont réunis ici. Chaque sujet a sa propre conversation.", localPreview: "Voici les sujets autorisés de votre chat. Ceux de l'ordinateur de votre partenaire seront ajoutés après la connexion.", noTopics: "Aucun sujet autorisé pour la personne sélectionnée.", addTopic: "Ajouter un sujet pour cette paire", discuss: "Discuter tous les sujets", discussing: "Les agents discutent…", analysis: "PERSONNES ET SUJETS", analysisTitle: "Préparé à partir du chat de base", analyzing: "Codex identifie les personnes et prépare les sujets…", noAnalysis: "Les personnes et sujets apparaîtront ici après l’export.", people: "Personnes du contexte", about: "À propos de", with: "Discuter avec", approve: "Autoriser la discussion", cross: "Ce sujet concerne une autre personne — vérifiez soigneusement le destinataire.", unclear: "Le destinataire est incertain — vérifiez avant d’autoriser." },
  }[language];
  const onboardingText = {
    ru: { eyebrow: "ПЕРВЫЙ ЗАПУСК", title: "Сначала подготовим ваш контекст", lead: "Выберите один чат, который Codex проанализирует как личную основу агента. Другому компьютеру исходные реплики не передаются.", chooseTitle: "1. Выберите базовый чат", chooseHint: "Откроем список ваших проектов и чатов Codex и ChatGPT.", processingTitle: "Подготавливаем контекст", resumeTitle: "Дополняем сохранённый контекст", export: "Получаем ваши реплики", people: "Определяем людей", topics: "Готовим возможные темы", finalizing: "Собираем итоговые рекомендации", waiting: "Это может занять несколько минут. Можно оставить приложение открытым.", resumeWaiting: "Уже найденные люди и темы сохранены. Добавляем только то, что изменилось в чате.", reviewTitle: "Проверьте людей и темы", reviewHint: "Исправьте, о ком тема и с кем её можно обсуждать. Ничего не передаётся без вашего разрешения.", finish: "Темы проверены — перейти к подключению", noPeople: "Люди пока не определены. Обновите выгрузку или выберите другой чат." },
    en: { eyebrow: "FIRST RUN", title: "First, prepare your context", lead: "Choose one chat as your agent's private foundation. Raw messages remain on this computer.", chooseTitle: "1. Choose a base chat", chooseHint: "We'll open your Codex projects and chats.", processingTitle: "Preparing context", resumeTitle: "Updating your saved context", export: "Reading your messages", people: "Identifying people", topics: "Preparing possible topics", finalizing: "Assembling final recommendations", waiting: "This can take a few minutes. You may leave the app open.", resumeWaiting: "Existing people and topics are preserved. Only changes from the chat are being added.", reviewTitle: "Review people and topics", reviewHint: "Correct who a topic is about and who may discuss it. Nothing is shared without your approval.", finish: "Topics reviewed — continue to connection", noPeople: "No people were identified. Refresh the export or choose another chat." },
    cs: { eyebrow: "PRVNÍ SPUŠTĚNÍ", title: "Nejprve připravíme váš kontext", lead: "Vyberte jeden chat jako soukromý základ agenta. Původní zprávy zůstanou v tomto počítači.", chooseTitle: "1. Vyberte základní chat", chooseHint: "Otevřeme seznam vašich projektů a chatů Codex.", processingTitle: "Připravujeme kontext", resumeTitle: "Doplňujeme uložený kontext", export: "Načítáme vaše zprávy", people: "Rozpoznáváme osoby", topics: "Připravujeme možná témata", finalizing: "Sestavujeme konečná doporučení", waiting: "Může to trvat několik minut. Aplikaci můžete nechat otevřenou.", resumeWaiting: "Nalezené osoby a témata zůstávají zachována. Přidáváme jen změny z chatu.", reviewTitle: "Zkontrolujte osoby a témata", reviewHint: "Opravte, koho se téma týká a s kým je lze probírat. Bez vašeho svolení se nic nesdílí.", finish: "Témata zkontrolována — pokračovat k propojení", noPeople: "Nebyly rozpoznány žádné osoby. Obnovte export nebo vyberte jiný chat." },
    fr: { eyebrow: "PREMIER DÉMARRAGE", title: "Préparons d'abord votre contexte", lead: "Choisissez un chat comme base privée de votre agent. Les messages bruts restent sur cet ordinateur.", chooseTitle: "1. Choisissez un chat de base", chooseHint: "Nous ouvrirons vos projets et chats Codex.", processingTitle: "Préparation du contexte", resumeTitle: "Mise à jour du contexte enregistré", export: "Lecture de vos messages", people: "Identification des personnes", topics: "Préparation des sujets possibles", finalizing: "Assemblage des recommandations finales", waiting: "Cela peut prendre quelques minutes. Vous pouvez laisser l'application ouverte.", resumeWaiting: "Les personnes et sujets existants sont conservés. Seuls les changements du chat sont ajoutés.", reviewTitle: "Vérifiez les personnes et les sujets", reviewHint: "Corrigez qui est concerné et avec qui le sujet peut être discuté. Rien n'est partagé sans votre accord.", finish: "Sujets vérifiés — passer à la connexion", noPeople: "Aucune personne n'a été identifiée. Actualisez l'export ou choisissez un autre chat." },
  }[language];
  const registryText = {
    ru: { topicsFor: "Темы для", needReview: "нужно проверить", all: "Все", review: "Проверить", approved: "Разрешены", allowedOf: "разрешено из", allowSafe: "Разрешить безопасные", search: "Найти тему", collapse: "Свернуть", expand: "Показать подробности", noFilteredTopics: "В этом фильтре тем нет." },
    en: { topicsFor: "Topics for", needReview: "need review", all: "All", review: "Review", approved: "Allowed", allowedOf: "allowed of", allowSafe: "Allow safe topics", search: "Find a topic", collapse: "Collapse", expand: "Show details", noFilteredTopics: "No topics match this filter." },
    cs: { topicsFor: "Témata pro", needReview: "je třeba zkontrolovat", all: "Vše", review: "Zkontrolovat", approved: "Povoleno", allowedOf: "povoleno z", allowSafe: "Povolit bezpečná témata", search: "Najít téma", collapse: "Sbalit", expand: "Zobrazit podrobnosti", noFilteredTopics: "Tomuto filtru neodpovídají žádná témata." },
    fr: { topicsFor: "Sujets pour", needReview: "à vérifier", all: "Tous", review: "Vérifier", approved: "Autorisés", allowedOf: "autorisés sur", allowSafe: "Autoriser les sujets sûrs", search: "Rechercher un sujet", collapse: "Réduire", expand: "Afficher les détails", noFilteredTopics: "Aucun sujet ne correspond à ce filtre." },
  }[language];
  const navigationText = {
    ru: { start: "Первый запуск", connection: "Подключение", context: "Исходный чат и темы", reports: "Итоги разговоров", settings: "Имя и автозапуск", setupTitle: "Подготовка к первому разговору", connectionTitle: "Подключение и темы", contextTitle: "Исходный чат и темы", reportsTitle: "Итоги разговоров", settingsTitle: "Имя и автозапуск" },
    en: { start: "First run", connection: "Connection", context: "Source chat and topics", reports: "Conversation results", settings: "Name and startup", setupTitle: "Prepare the first conversation", connectionTitle: "Connection and topics", contextTitle: "Source chat and topics", reportsTitle: "Conversation results", settingsTitle: "Name and startup" },
    cs: { start: "První spuštění", connection: "Propojení", context: "Zdrojový chat a témata", reports: "Výsledky rozhovorů", settings: "Jméno a spuštění", setupTitle: "Příprava prvního rozhovoru", connectionTitle: "Propojení a témata", contextTitle: "Zdrojový chat a témata", reportsTitle: "Výsledky rozhovorů", settingsTitle: "Jméno a spuštění" },
    fr: { start: "Premier démarrage", connection: "Connexion", context: "Chat source et sujets", reports: "Résultats des conversations", settings: "Nom et démarrage", setupTitle: "Préparer la première conversation", connectionTitle: "Connexion et sujets", contextTitle: "Chat source et sujets", reportsTitle: "Résultats des conversations", settingsTitle: "Nom et démarrage" },
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
    ru: { empty: "Готовые ответы появятся здесь автоматически.", files: "Показать файлы в папке", messages: "реплик", answer: "Предполагаемый ответ —", conversation: "Прочитать разговор агентов" },
    en: { empty: "Completed answers will appear here automatically.", files: "Show files in folder", messages: "messages", answer: "Likely answer —", conversation: "Read the agents’ conversation" },
    cs: { empty: "Hotové odpovědi se zde objeví automaticky.", files: "Zobrazit soubory ve složce", messages: "zpráv", answer: "Předpokládaná odpověď —", conversation: "Přečíst rozhovor agentů" },
    fr: { empty: "Les réponses terminées apparaîtront ici automatiquement.", files: "Afficher les fichiers dans le dossier", messages: "messages", answer: "Réponse probable —", conversation: "Lire la conversation des agents" },
  }[language];
  const pageTitle = activeSection === "context" ? navigationText.contextTitle : activeSection === "reports" ? navigationText.reportsTitle : activeSection === "settings" ? navigationText.settingsTitle : state.onboardingComplete ? navigationText.connectionTitle : navigationText.setupTitle;
  const selectedPairPersonId = counterpartPersonId || state.remote.counterpartPersonId;
  const localPairTopics = state.contextAnalysis?.topics.filter((item) => item.approved && item.discussWithPersonId === selectedPairPersonId).map((item) => item.title) ?? [];
  const displayedPairTopics = [...new Set([...localPairTopics, ...state.pairTopics, ...state.pendingTopics, ...state.activeTopics])];

  function goTo(section: SectionId) {
    setActiveSection(section);
    setShowContextPicker(false);
    if (section === "context" && !state.context && !contextThreads.length) void loadContextThreads();
    window.setTimeout(() => document.getElementById(section)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  async function changeLanguage(value: Language) {
    setLanguage(value);
    localStorage.setItem("family-bridge-language", value);
    if (api) setState(await api.setLanguage(value));
  }

  const api = window.familyBridge;
  useEffect(() => {
    const refreshLocalContext = () => void api?.getLocalContextState().then((local) => {
      setState((current) => ({ ...current, context: local.context, contextAnalysis: local.contextAnalysis }));
    });
    const refreshState = () => void api?.getState().then(async (current) => {
      const saved = localStorage.getItem("family-bridge-language") as Language | null;
      const next = saved && saved !== current.language ? await api.setLanguage(saved) : current;
      setState(next);
      setLanguage(next.language);
      setDisplayName(next.displayName);
      setCounterpartPersonId(next.remote.counterpartPersonId || next.contextAnalysis?.people[0]?.id || "");
      setReviewPersonId(next.contextAnalysis?.people[0]?.id || "");
    });
    refreshState();
    refreshLocalContext();
    const onFocus = () => {
      refreshLocalContext();
      refreshState();
    };
    window.addEventListener("focus", onFocus);
    const unsubscribe = api?.onEvent((raw) => {
      const event = raw as { type?: string; available?: boolean; version?: string; checking?: boolean; downloading?: boolean; ready?: boolean; error?: string; peerName?: string; context?: AppState["context"]; analysis?: AppState["contextAnalysis"]; topics?: string[]; pairTopics?: string[]; activeTopics?: string[]; reports?: string[]; reportSummaries?: AppState["reportSummaries"]; questions?: AppState["ownerQuestions"]; running?: boolean; syncing?: boolean; progress?: number };
      if (event.type === "peer" && event.peerName) setState((current) => ({ ...current, remote: { ...current.remote, peerName: event.peerName } }));
      if (event.type === "context" && event.context) setState((current) => ({ ...current, context: event.context }));
      if (event.type === "context-analysis" && event.analysis) {
        setState((current) => ({ ...current, contextAnalysis: event.analysis }));
        setCounterpartPersonId((current) => current || event.analysis?.people[0]?.id || "");
        setReviewPersonId((current) => current && event.analysis?.people.some((person) => person.id === current) ? current : event.analysis?.people[0]?.id || "");
      }
      if (event.type === "topics" && event.topics) setState((current) => ({ ...current, pendingTopics: event.topics!, pairTopics: event.pairTopics ?? current.pairTopics, activeTopics: event.activeTopics ?? current.activeTopics }));
      if (event.type === "reports" && event.reports && event.reportSummaries) setState((current) => ({ ...current, reports: event.reports!, reportSummaries: event.reportSummaries! }));
      if (event.type === "owner-questions" && event.questions) {
        setState((current) => ({ ...current, ownerQuestions: event.questions! }));
        if (event.questions.length) setActiveSection("overview");
      }
      if (event.type === "context-sync") setState((current) => ({ ...current, contextSyncing: Boolean(event.syncing), contextSyncProgress: event.progress ?? 0 }));
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
      window.removeEventListener("focus", onFocus);
      unsubscribe?.();
    };
  }, [api]);

  useEffect(() => {
    if (!api || state.contextAnalysis?.status !== "analyzing") return;
    let active = true;
    const reconcile = () => void api.getLocalContextState().then((local) => {
      if (!active) return;
      setState((current) => ({ ...current, context: local.context, contextAnalysis: local.contextAnalysis }));
    });
    reconcile();
    const timer = window.setInterval(reconcile, 1_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [api, state.contextAnalysis?.status]);

  const health = useMemo(
    () => state.codex.installed && state.codex.authenticated,
    [state.codex],
  );

  async function addTopic() {
    if (!topic.trim()) return;
    if (api) setState(await api.addTopic(topic));
    else setState((current) => ({ ...current, pendingTopics: [...current.pendingTopics, topic] }));
    setTopic("");
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
    if (!api) return;
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

  async function refreshContextNow() {
    if (!api) return;
    setContextLoading(true); setError("");
    try { setState(await api.refreshContextNow()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setContextLoading(false); }
  }

  async function createInvite() {
    if (!api || !counterpartPersonId) return;
    setBusy(true); setError(""); setInviteCopied(false);
    try { setState(await api.createPair(counterpartPersonId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function connectWithInvite() {
    if (!api || !counterpartPersonId || !inviteCode.trim()) return;
    setBusy(true); setError("");
    try { setState(await api.joinPair(inviteCode, counterpartPersonId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function copyInvite() {
    if (!state.remote.invite) return;
    await navigator.clipboard.writeText(state.remote.invite);
    setInviteCopied(true);
  }

  async function updateContextTopic(topicId: string, update: { aboutPersonIds?: string[]; discussWithPersonId?: string; approved?: boolean }) {
    if (!api) return;
    setError("");
    try { setState(await api.updateContextTopic({ topicId, ...update })); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function completeOnboarding() {
    if (!api) return;
    setError("");
    try { setState(await api.completeOnboarding()); }
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
    const selectedPerson = topicPeople.find((person) => person.id === reviewPersonId) ?? topicPeople[0];
    const allForPerson = state.contextAnalysis.topics.filter((item) => item.discussWithPersonId === selectedPerson.id);
    const selectedPersonTopics = allForPerson
      .filter((item) => topicFilter === "all" || topicFilter === "approved" && item.approved || topicFilter === "review" && item.sensitivity !== "direct")
      .filter((item) => !topicSearch.trim() || `${item.title} ${item.reason}`.toLocaleLowerCase(language).includes(topicSearch.trim().toLocaleLowerCase(language)))
      .sort((left, right) => Number(left.sensitivity === "direct") - Number(right.sensitivity === "direct") || left.title.localeCompare(right.title, language));
    const reviewCount = allForPerson.filter((item) => item.sensitivity !== "direct").length;
    const approvedCount = allForPerson.filter((item) => item.approved).length;
    return <div className="topic-registry">
      <div className="person-tabs" role="tablist">{topicPeople.map((person) => {
        const count = state.contextAnalysis!.topics.filter((item) => item.discussWithPersonId === person.id).length;
        return <button type="button" role="tab" aria-selected={person.id === selectedPerson.id} className={person.id === selectedPerson.id ? "active" : ""} key={person.id} onClick={() => setReviewPersonId(person.id)}>{personLabel(person.id)} <span>{count}</span></button>;
      })}</div>
      <div className="registry-heading"><div><h4>{registryText.topicsFor}: {personLabel(selectedPerson.id)}</h4><p>{allForPerson.length} · {reviewCount} {registryText.needReview}</p></div><div className="registry-controls"><input value={topicSearch} onChange={(event) => setTopicSearch(event.target.value)} placeholder={registryText.search} aria-label={registryText.search} /><div className="registry-filters"><button className={topicFilter === "all" ? "active" : ""} onClick={() => setTopicFilter("all")}>{registryText.all}</button><button className={topicFilter === "review" ? "active" : ""} onClick={() => setTopicFilter("review")}>{registryText.review}</button><button className={topicFilter === "approved" ? "active" : ""} onClick={() => setTopicFilter("approved")}>{registryText.approved}</button></div></div></div>
      <div className="registry-toolbar"><span>{approvedCount} {registryText.allowedOf} {allForPerson.length}</span><button className="ghost" onClick={() => void approveSafeTopics(selectedPerson.id)}>{registryText.allowSafe}</button></div>
      <div className="topic-rows">{selectedPersonTopics.map((item) => {
        const expanded = expandedTopicIds.has(item.id);
        const about = item.aboutPersonIds.map(personLabel).join(", ") || "—";
        return <div className={`topic-row ${item.sensitivity} ${expanded ? "expanded" : ""}`} key={item.id}>
          <div className="topic-row-main"><label className="topic-approval"><input type="checkbox" checked={item.approved} onChange={(event) => void updateContextTopic(item.id, { approved: event.target.checked })} /><span>{item.title}</span></label><span className="topic-about">{workflowText.about}: {about}{item.sensitivity !== "direct" ? ` · ${registryText.review}` : ""}</span><button className="topic-expand" aria-label={expanded ? registryText.collapse : registryText.expand} aria-expanded={expanded} onClick={() => toggleTopicDetails(item.id)}><ChevronDown size={17} /></button></div>
          {expanded && <div className="topic-row-detail"><p>{item.reason}</p><div className="route-fields"><label>{workflowText.about}<select value={item.aboutPersonIds[0] || ""} onChange={(event) => void updateContextTopic(item.id, { aboutPersonIds: [event.target.value] })}>{state.contextAnalysis!.people.map((person) => <option value={person.id} key={person.id}>{personLabel(person.id)}</option>)}</select></label><label>{workflowText.with}<select value={item.discussWithPersonId} onChange={(event) => void updateContextTopic(item.id, { discussWithPersonId: event.target.value })}>{state.contextAnalysis!.people.map((person) => <option value={person.id} key={person.id}>{personLabel(person.id)}</option>)}</select></label></div>{item.sensitivity === "cross_person" && <small className="route-warning">{workflowText.cross}</small>}{item.sensitivity === "unclear" && <small className="route-warning">{workflowText.unclear}</small>}</div>}
        </div>;
      })}{!selectedPersonTopics.length && <div className="empty">{registryText.noFilteredTopics}</div>}</div>
    </div>;
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><MessageCircleHeart size={25} /><span>Family Bridge</span></div>
        <nav>
          <button className={activeSection === "overview" ? "active" : ""} onClick={() => goTo("overview")}><Activity size={18} /><span>{state.onboardingComplete ? navigationText.connection : navigationText.start}</span>{state.ownerQuestions.length > 0 && <b className="nav-badge">{state.ownerQuestions.length}</b>}</button>
          <button className={activeSection === "context" ? "active" : ""} onClick={() => goTo("context")}><BookHeart size={18} />{navigationText.context}</button>
          <button className={activeSection === "reports" ? "active" : ""} onClick={() => goTo("reports")}><ScrollText size={18} />{navigationText.reports}</button>
          <button className={activeSection === "settings" ? "active" : ""} onClick={() => goTo("settings")}><Settings2 size={18} />{navigationText.settings}</button>
        </nav>
        <div className="sidebar-status">
          <span className={health ? "status-dot online" : "status-dot"} />
          <div><strong>{health ? t.ready : t.setup}</strong><small>{state.codex.version}</small></div>
        </div>
      </aside>

      <main id="overview" className={`${!state.onboardingComplete && activeSection === "overview" ? "onboarding-main" : ""} ${activeSection === "context" ? "context-main" : ""}`.trim()}>
        <header>
          <div><h1>{pageTitle}</h1></div>
          <div className="header-tools"><label>{t.language}<select value={language} onChange={(e) => void changeLanguage(e.target.value as Language)}>{(Object.keys(languageNames) as Language[]).map((key) => <option value={key} key={key}>{languageNames[key]}</option>)}</select></label><div className="live-pill"><CircleDot size={14} />{t.background}</div></div>
        </header>

        {state.contextSyncing && state.context && <section className="context-refresh-note"><LoaderCircle className="spin" size={18} /><div><div className="context-refresh-title"><strong>{contextRefreshText.title}</strong><b>{state.contextSyncProgress}%</b></div><span>{contextRefreshText.body}</span><progress max="100" value={state.contextSyncProgress} /></div></section>}

        {activeSection === "overview" && state.ownerQuestions.map((item) => <section className="panel owner-question-panel" key={item.id}>
          <div className="owner-question-heading"><div><p className="eyebrow">{ownerQuestionText.eyebrow}</p><h3>{ownerQuestionText.title}</h3></div><Bell size={21} /></div>
          <div className="owner-question-topic"><span>{ownerQuestionText.paused}</span><strong>{item.topic}</strong></div>
          <p className="owner-question">{item.question}</p>
          <p className="owner-question-privacy"><ShieldCheck size={15} />{ownerQuestionText.privacy}</p>
          <textarea value={ownerAnswers[item.id] || ""} onChange={(event) => setOwnerAnswers((current) => ({ ...current, [item.id]: event.target.value }))} placeholder={ownerQuestionText.placeholder} disabled={answeringQuestionId === item.id} />
          <div className="owner-question-actions">
            <button className="primary" disabled={!ownerAnswers[item.id]?.trim() || answeringQuestionId === item.id} onClick={() => void answerOwnerQuestion(item.id, "answer")}>{answeringQuestionId === item.id ? ownerQuestionText.processing : ownerQuestionText.answer}</button>
            <button className="ghost" disabled={answeringQuestionId === item.id} onClick={() => void answerOwnerQuestion(item.id, "unknown")}>{ownerQuestionText.unknown}</button>
            <button className="ghost" disabled={answeringQuestionId === item.id} onClick={() => void answerOwnerQuestion(item.id, "decline")}>{ownerQuestionText.decline}</button>
          </div>
        </section>)}

        {activeSection === "overview" && !state.onboardingComplete && <section className="panel onboarding-panel">
          {state.contextAnalysis?.status !== "ready" && <div className="onboarding-intro"><p>{onboardingText.lead}</p></div>}
          <div className="onboarding-steps"><div className={state.context ? "done" : "active"}><span>{state.context ? <Check size={16} /> : "1"}</span>{onboardingText.chooseTitle}</div><div className={state.contextAnalysis?.status === "ready" ? "done" : state.context ? "active" : ""}><span>{state.contextAnalysis?.status === "ready" ? <Check size={16} /> : "2"}</span>{onboardingText.processingTitle}</div><div className={state.contextAnalysis?.status === "ready" ? "active" : ""}><span>3</span>{onboardingText.reviewTitle}</div></div>
          {!state.context && <div className="onboarding-stage"><h3>{onboardingText.chooseTitle}</h3><p>{onboardingText.chooseHint}</p><button className="primary" disabled={contextLoading} onClick={() => void loadContextThreads()}>{contextText.choose}</button></div>}
          {showContextPicker && !state.context && <div className="context-picker onboarding-picker">{contextPicker()}</div>}
          {state.context && state.contextAnalysis?.status !== "ready" && (() => { const hasSavedAnalysis = Boolean(state.contextAnalysis?.people.length || state.contextAnalysis?.topics.length); const finalizing = state.contextAnalysis?.progress?.stage === "consolidating"; return <div className="onboarding-stage processing-stage"><h3>{hasSavedAnalysis ? onboardingText.resumeTitle : onboardingText.processingTitle}</h3><div className="processing-source"><strong>{state.context.project} · {state.context.title}</strong><small>{state.context.messageCount ?? 0} {contextText.messages.toLowerCase()}</small></div><div className="processing-list"><div className={state.context.status === "ready" ? "done" : "active"}>{state.context.status === "ready" ? <Check size={18} /> : <LoaderCircle className="spin" size={18} />}<span>{onboardingText.export}</span></div><div className={hasSavedAnalysis || finalizing ? "done" : state.contextAnalysis ? "active" : "waiting"}>{hasSavedAnalysis || finalizing ? <Check size={18} /> : <LoaderCircle className={state.contextAnalysis ? "spin" : ""} size={18} />}<span>{onboardingText.people}</span></div><div className={state.contextAnalysis ? "active" : "waiting"}><LoaderCircle className={state.contextAnalysis ? "spin" : ""} size={18} /><span>{finalizing ? onboardingText.finalizing : onboardingText.topics}{state.contextAnalysis?.progress && !finalizing ? ` · ${state.contextAnalysis.progress.current}/${Math.max(1, state.contextAnalysis.progress.total - 1)}` : ""}</span></div></div><p className="muted">{hasSavedAnalysis ? onboardingText.resumeWaiting : onboardingText.waiting}</p>{state.contextAnalysis?.status === "error" && <div className="analysis-error">{state.contextAnalysis.error}</div>}</div>; })()}
          {state.contextAnalysis?.status === "ready" && <div className="onboarding-stage review-stage"><div className="review-intro"><div><h3>{onboardingText.reviewTitle}</h3><p>{onboardingText.reviewHint}</p></div><button className="ghost" onClick={() => void loadContextThreads()}>{contextText.change}</button></div>{showContextPicker && <div className="context-picker onboarding-picker">{contextPicker()}</div>}{topicRegistry()}<div className="onboarding-finish"><button className="primary" onClick={() => void completeOnboarding()}>{onboardingText.finish}</button></div></div>}
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
              <label className="counterpart-select"><span>{workflowText.who}</span><select value={counterpartPersonId} onChange={(e) => setCounterpartPersonId(e.target.value)}><option value="">{workflowText.choosePerson}</option>{state.contextAnalysis.people.map((person) => <option key={person.id} value={person.id}>{personLabel(person.id)}</option>)}</select></label>
              <div className="pair-actions"><button className="primary" disabled={!counterpartPersonId || busy} onClick={() => void createInvite()}>{state.remote.invite ? workflowText.recreate : workflowText.create}</button></div>
              {state.remote.invite && <div className="invite-box"><p>{t.shareCode}</p><textarea readOnly value={state.remote.invite} onFocus={(e) => e.currentTarget.select()} /><button className="ghost" onClick={() => void copyInvite()}>{inviteCopied ? workflowText.copied : workflowText.copy}</button></div>}
              <div className="join-box"><span>{workflowText.orJoin}</span><div className="input-row"><input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder={t.pasteInvite}/><button disabled={!counterpartPersonId || !inviteCode.trim() || busy} onClick={() => void connectWithInvite()}>{workflowText.connect}</button></div></div>
            </> : <div className="context-needed"><span>{workflowText.needContext}</span><button className="ghost" onClick={() => goTo("context")}>{workflowText.openContext}</button></div>}
          </>}
          {state.remote.connected && <div className="connected-card"><strong>{state.remote.peerName || deviceText.partnerName}</strong><span>{workflowText.mapped}: {state.remote.counterpartLabel || "—"}</span></div>}
        </section>}

        <div className="grid single-screen">
          {activeSection === "context" && <section className="panel context-panel">
            <div className="panel-title"><div><p className="eyebrow">{contextText.eyebrow}</p><h3>{contextText.title}</h3></div><BookHeart size={20} /></div>
            {state.context ? <div className="context-current">
              <div><span>{contextText.project}</span><strong>{state.context.project}</strong></div>
              <div><span>{contextText.chat}</span><strong>{state.context.title}</strong></div>
              <div><span>{contextText.messages}</span><strong>{state.context.messageCount ?? "—"}</strong></div>
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
            <div className="topic-list">{displayedPairTopics.map((item) => {
              const report = state.reportSummaries.find((candidate) => candidate.topic === item);
              const active = state.activeTopics.includes(item);
              const pending = state.pendingTopics.includes(item);
              const status = report ? topicStatusText.complete : active ? topicStatusText.active : pending ? topicStatusText.pending : topicStatusText.selected;
              return <div className="topic pair-topic" key={item}><span>{item}</span><button className={`topic-state ${report ? "complete" : active ? "active" : ""}`} disabled={!report} onClick={() => report && goTo("reports")}>{status}</button></div>;
            })}{!displayedPairTopics.length && <div className="empty">{workflowText.noTopics}</div>}</div>
            <div className="input-row"><input disabled={!state.remote.counterpartPersonId} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={workflowText.addTopic} onKeyDown={(e) => e.key === "Enter" && void addTopic()} /><button disabled={!state.remote.counterpartPersonId || !topic.trim()} onClick={() => void addTopic()}>{t.add}</button></div>
            <div className="actions"><button className="primary" disabled={busy || !state.remote.connected || !state.pendingTopics.length} onClick={() => void discussAllTopics()}><Sparkles size={17} />{busy ? workflowText.discussing : workflowText.discuss}</button></div>
          </section>}

          {activeSection === "reports" && <section className="panel report-panel" id="reports">
            <div className="panel-title"><div><p className="eyebrow">{t.result}</p><h3>{t.latest}</h3></div><ScrollText size={20} /></div>
            {!state.reportSummaries.length && <div className="empty tall"><ScrollText size={28} /><span>{reportsText.empty}</span></div>}
            <div className="report-cards">{state.reportSummaries.map((report) => <article className="report-card" key={report.id}>
              <div className="report-heading"><strong>{report.topic}</strong><time>{report.completedAt ? new Date(report.completedAt).toLocaleString(language) : ""}</time></div>
              <div className="report-answer"><small>{reportsText.answer} {report.answerFrom}</small><p>{report.summary}</p></div>
              <details className="report-transcript"><summary>{reportsText.conversation} · {report.messageCount} {reportsText.messages}</summary><div>{report.messages.map((message, index) => <div className={`transcript-message ${message.local ? "local" : "peer"}`} key={`${report.id}-${index}`}><strong>{message.speaker}</strong><p>{message.text}</p></div>)}</div></details>
            </article>)}</div>
            <button className="link-button" onClick={() => void api?.openReports()}>{reportsText.files}</button>
          </section>}

          {activeSection === "settings" && <>
            <section className="panel settings-panel" id="settings">
              <div className="panel-title"><div><p className="eyebrow">{t.settings}</p><h3>{deviceText.question}</h3></div><Settings2 size={20} /></div>
              <div className="input-row"><input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={deviceText.placeholder} /><button disabled={!displayName.trim()} onClick={async () => api && setState(await api.setDisplayName(displayName))}>{deviceText.save}</button></div>
              <div className="settings-actions">
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
