import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, memo, useDeferredValue } from "react";
import { createPortal } from "react-dom";
import "./app.css";
import { imgSrc, fmtTime, parseM3U, genCSS, API, ENABLE_ADSTERRA, ENABLE_HILLTOP, ADSTERRA_URL, debounce, trackAnalytics, trackAnalyticsScreen, resolveUrl } from "./utils.js";
import Player from "./components/Player.jsx";
import PlaybackLoadingOverlay from "./components/PlaybackLoadingOverlay.jsx";
import { createPlaybackResolveCoordinator } from "./playback-resolve.js";
import DirectHLSView from "./components/DirectHLSView.jsx";
import TimelineGrid from "./components/TimelineGrid.jsx";
import VirtualGrid from "./components/VirtualGrid.jsx";
import { classifyStreamUrl } from "./stream-classifier.js";
import { stripTransientStreamFields } from "./stream-routing.js";
import AuthScreen from './components/AuthScreen.jsx';
import SettingsView from './components/SettingsView.jsx';
import DiscoverView from './components/DiscoverView.jsx';
import Setup from './components/Setup.jsx';
import { setEncKeySource, encryptConnections, decryptConnections } from './auth-utils.js';
import { GUEST_ID, authHeaders, authFetch, track, db, proxyFetch, safeJsonFetch, makeXtreamAPI } from "./app-runtime.js";
import { useStreamVault } from "./useStreamVault.js";
import { lifecycleFailureMessage, mergeConnectionSnapshots, mergeConnectionsWithinLimit } from "./connection-lifecycle.js";
import { isAdEligibleRole } from "./account-policy.js";
import {
  clearContentSessionToken,
  contentSessionToken,
  getAppHomeUrl,
  isHttpContentMode,
  maybeOpenDirectContentSession,
  navigateToAppHome,
  refreshContentSession,
  shouldUseTokenPlayerForItem,
} from "./direct-content-session.js";
import { hydrateContentSession } from "./app-session.js";
import { describeStalkerCatalogLoading, loadInitialStalkerCatalog, shouldUseGlobalCatalogLoader } from "./stalker-catalog-loading.js";
import { createStalkerCatalogApi, formatStalkerCatalogError } from "./stalker-catalog-api.js";
import { createStalkerCatalogCache } from "./stalker-catalog-cache.js";
import { stalkerCatalogConnectionFingerprint } from "./stalker-catalog-identity.js";
import { discoverySeed, selectDiscoveryCategories } from "./stalker-discovery.js";
import { findExactCatalogItem } from "./stalker-playback-helpers.js";
import { toSeriesEpisodeDisplay } from "./series-episode-display.js";

// ── i18n ──
const RTL_LANGS = ["ar","ur"];
const LANG_META = {en:"English",es:"Español",fr:"Français",de:"Deutsch",it:"Italiano",zh:"中文",ar:"العربية",pt:"Português",hi:"हिन्दी",ur:"اردو"};
const LANGS = {
  "en": {
    "tagline": "Your personal IPTV client",
    "discover": "Discover",
    "live": "Live TV",
    "movies": "Movies",
    "series": "Series",
    "favorites": "Favorites",
    "continueWatching": "Continue Watching",
    "tvGuide": "TV Guide",
    "globalSearch": "Global Search",
    "directPlay": "Direct Play",
    "watch": "Watch",
    "tools": "Tools",
    "savedConns": "Saved Connections",
    "orAddNew": "or add new",
    "connect": "Connect",
    "connectArrow": "Connect →",
    "disconnect": "Disconnect",
    "feedback": "Feedback",
    "send": "Send",
    "cancel": "Cancel",
    "close": "Close",
    "refresh": "Refresh",
    "search": "Search",
    "prev": "Prev",
    "next": "Next",
    "fav": "Fav",
    "pip": "PiP",
    "play": "Play",
    "go": "Go",
    "playPause": "Play/Pause",
    "fullscreen": "Fullscreen",
    "mute": "Mute",
    "channels": "Channels",
    "volume": "Volume",
    "portalURL": "Portal URL",
    "macAddress": "MAC Address",
    "serverURL": "Server URL",
    "username": "Username",
    "password": "Password",
    "playlistURL": "Playlist URL",
    "connFailed": "Connection failed",
    "connecting": "Connecting…",
    "import": "Import",
    "xtreamCodes": "Xtream Codes",
    "m3uPlaylist": "M3U Playlist",
    "stalkerPortal": "Stalker Portal",
    "directHLS": "Direct HLS",
    "noChannels": "No channels found",
    "loading": "Loading…",
    "loadingSection": "Loading {0}…",
    "playbackErr": "Playback Error",
    "networkErr": "Network Error",
    "streamNotFound": "Stream Not Found",
    "accessDenied": "Access Denied",
    "serverErr": "Server Error",
    "noContent": "No content found",
    "selectCategory": "Select a category",
    "fetchingItems": "Fetching items from portal.",
    "tryDifferent": "Try a different category or clear your search.",
    "now": "Now",
    "loadEPG": "Load EPG",
    "noChannelsLoaded": "No channels loaded",
    "noEPGData": "No EPG data",
    "filterChannels": "Filter channels…",
    "sendFeedback": "Send Feedback",
    "thankYou": "Thank you!",
    "feedbackReceived": "Your feedback has been received.",
    "feedbackHint": "Bug reports, feature requests, or general comments",
    "feedbackPlaceholder": "What's on your mind?",
    "sending": "Sending...",
    "noFavsYet": "No favorites yet",
    "favHint": "Click the ♡ icon on any channel or movie to add it here.",
    "liveTV": "Live TV",
    "nothingStarted": "Nothing started yet",
    "resumeHint": "Watch some content and it will appear here for easy resuming.",
    "resumeWatching": "Resume Watching",
    "recentlyWatched": "Recently Watched",
    "searchEverything": "Search everything",
    "searchHint": "Movies, Series or Channels",
    "settings": "Settings"
  },
  "es": {
    "discover": "Descubrir",
    "live": "TV en Vivo",
    "movies": "Películas",
    "series": "Series",
    "favorites": "Favoritos",
    "continueWatching": "Seguir Viendo",
    "tvGuide": "Guía TV",
    "globalSearch": "Búsqueda Global",
    "directPlay": "Reproducción Directa",
    "watch": "Ver",
    "tools": "Herramientas",
    "savedConns": "Conexiones Guardadas",
    "orAddNew": "o agregar nueva",
    "connect": "Conectar",
    "connectArrow": "Conectar →",
    "disconnect": "Desconectar",
    "feedback": "Comentarios",
    "send": "Enviar",
    "cancel": "Cancelar",
    "close": "Cerrar",
    "refresh": "Actualizar",
    "search": "Buscar",
    "prev": "Anterior",
    "next": "Siguiente",
    "fav": "Fav",
    "pip": "PiP",
    "play": "Reproducir",
    "go": "Ir",
    "playPause": "Reproducir/Pausa",
    "fullscreen": "Pantalla Completa",
    "mute": "Silenciar",
    "channels": "Canales",
    "volume": "Volumen",
    "portalURL": "URL del Portal",
    "macAddress": "Dirección MAC",
    "serverURL": "URL del Servidor",
    "username": "Usuario",
    "password": "Contraseña",
    "playlistURL": "URL de Lista",
    "connFailed": "Conexión fallida",
    "connecting": "Conectando…",
    "import": "Importar",
    "xtreamCodes": "Xtream Codes",
    "m3uPlaylist": "Lista M3U",
    "stalkerPortal": "Portal Stalker",
    "directHLS": "HLS Directo",
    "noChannels": "No se encontraron canales",
    "loading": "Cargando…",
    "loadingSection": "Cargando {0}…",
    "playbackErr": "Error de Reproducción",
    "networkErr": "Error de Red",
    "streamNotFound": "Transmissão No Encontrada",
    "accessDenied": "Acceso Denegado",
    "serverErr": "Error del Servidor",
    "noContent": "No se encontró contenido",
    "selectCategory": "Seleccionar categoría",
    "fetchingItems": "Obteniendo elementos del portal.",
    "tryDifferent": "Pruebe otra categoría o borre su búsqueda.",
    "now": "Ahora",
    "loadEPG": "Cargar EPG",
    "noChannelsLoaded": "No hay canales cargados",
    "noEPGData": "Sin datos EPG",
    "filterChannels": "Filtrar canales…",
    "sendFeedback": "Enviar Comentarios",
    "thankYou": "¡Gracias!",
    "feedbackReceived": "Su comentario ha sido recibido.",
    "feedbackHint": "Reportes de errores, solicitudes o comentarios generales",
    "feedbackPlaceholder": "¿Qué tienes en mente?",
    "sending": "Enviando...",
    "noFavsYet": "Aún no hay favoritos",
    "favHint": "Haga clic en el icono ♡ en cualquier canal o película para agregarlo aquí.",
    "liveTV": "TV en Vivo",
    "nothingStarted": "Nada iniciado aún",
    "resumeHint": "Asista a algún contenido y aparecerá aquí.",
    "resumeWatching": "Seguir viendo",
    "recentlyWatched": "Visto recientemente",
    "searchEverything": "Buscar en todo",
    "searchHint": "Películas, Series o Canales",
    "settings": "Configuraciones"
  },
  "fr": {
    "discover": "Découvrir",
    "live": "TV en Direct",
    "movies": "Films",
    "series": "Séries",
    "favorites": "Favoris",
    "continueWatching": "Continuer à Regarder",
    "tvGuide": "Guide TV",
    "globalSearch": "Recherche Globale",
    "directPlay": "Lecture Directe",
    "watch": "Regarder",
    "tools": "Outils",
    "savedConns": "Connexions Enregistrées",
    "orAddNew": "ou ajouter nouvelle",
    "connect": "Connecter",
    "connectArrow": "Connecter →",
    "disconnect": "Déconnecter",
    "feedback": "Commentaires",
    "send": "Envoyer",
    "cancel": "Annuler",
    "close": "Fermer",
    "refresh": "Actualiser",
    "search": "Rechercher",
    "prev": "Préc.",
    "next": "Suiv.",
    "fav": "Fav",
    "pip": "PiP",
    "play": "Lecture",
    "go": "Go",
    "playPause": "Lecture/Pause",
    "fullscreen": "Plein Écran",
    "mute": "Muet",
    "channels": "Chaînes",
    "volume": "Volume",
    "portalURL": "URL du Portail",
    "macAddress": "Adresse MAC",
    "serverURL": "URL du Serveur",
    "username": "Identifiant",
    "password": "Mot de passe",
    "playlistURL": "URL de la Playlist",
    "connFailed": "Échec de connexion",
    "connecting": "Connexion…",
    "import": "Importer",
    "xtreamCodes": "Xtream Codes",
    "m3uPlaylist": "Playlist M3U",
    "stalkerPortal": "Portail Stalker",
    "directHLS": "HLS Direct",
    "noChannels": "Aucune chaîne trouvée",
    "loading": "Chargement…",
    "loadingSection": "Chargement de {0}…",
    "playbackErr": "Erreur de Lecture",
    "networkErr": "Erreur Réseau",
    "streamNotFound": "Flux Introuvable",
    "accessDenied": "Accès Refusé",
    "serverErr": "Erreur Serveur",
    "noContent": "Aucun contenu trouvé",
    "selectCategory": "Sélectionner une catégorie",
    "fetchingItems": "Récupération des éléments du portail.",
    "tryDifferent": "Essayez une autre catégorie ou effacez votre recherche.",
    "now": "Maintenant",
    "loadEPG": "Charger EPG",
    "noChannelsLoaded": "Aucune chaîne chargée",
    "noEPGData": "Pas de données EPG",
    "filterChannels": "Filtrer les chaînes…",
    "sendFeedback": "Envoyer un Commentaire",
    "thankYou": "Merci !",
    "feedbackReceived": "Votre commentaire a été reçu.",
    "feedbackHint": "Rapports de bugs, demandes de fonctionnalités ou commentaires généraux",
    "feedbackPlaceholder": "Qu'avez-vous en tête ?",
    "sending": "Envoi...",
    "noFavsYet": "Pas encore de favoris",
    "favHint": "Cliquez sur l'icône ♡ sur une chaîne ou un film pour l'ajouter ici.",
    "liveTV": "TV en Direct",
    "nothingStarted": "Rien n'a encore commencé",
    "resumeHint": "Regardez du contenu et il apparaîtra ici.",
    "resumeWatching": "Reprendre la lecture",
    "recentlyWatched": "Vus récemment",
    "searchEverything": "Tout rechercher",
    "searchHint": "Films, séries ou chaînes",
    "settings": "Paramètres"
  },
  "de": {
    "discover": "Entdecken",
    "live": "Live TV",
    "movies": "Filme",
    "series": "Serien",
    "favorites": "Favoriten",
    "continueWatching": "Weiter ansehen",
    "tvGuide": "TV Guide",
    "globalSearch": "Globale Suche",
    "directPlay": "Direkte Wiedergabe",
    "watch": "Ansehen",
    "tools": "Werkzeuge",
    "savedConns": "Gespeicherte Verbindungen",
    "orAddNew": "oder neu hinzufügen",
    "connect": "Verbinden",
    "connectArrow": "Verbinden →",
    "disconnect": "Trennen",
    "feedback": "Feedback",
    "send": "Senden",
    "cancel": "Abbrechen",
    "close": "Schließen",
    "refresh": "Aktualisieren",
    "search": "Suche",
    "prev": "Zurück",
    "next": "Weiter",
    "fav": "Fav",
    "pip": "PiP",
    "play": "Wiedergabe",
    "go": "Los",
    "playPause": "Play/Pause",
    "fullscreen": "Vollbild",
    "mute": "Stumm",
    "channels": "Sender",
    "volume": "Lautstärke",
    "portalURL": "Portal URL",
    "macAddress": "MAC Adresse",
    "serverURL": "Server URL",
    "username": "Benutzername",
    "password": "Passwort",
    "playlistURL": "Playlist URL",
    "connFailed": "Verbindung fehlgeschlagen",
    "connecting": "Verbinde…",
    "import": "Importieren",
    "xtreamCodes": "Xtream Codes",
    "m3uPlaylist": "M3U Playlist",
    "stalkerPortal": "Stalker Portal",
    "directHLS": "Direktes HLS",
    "noChannels": "Keine Sender gefunden",
    "loading": "Lade…",
    "loadingSection": "Lade {0}…",
    "playbackErr": "Wiedergabefehler",
    "networkErr": "Netzwerkfehler",
    "streamNotFound": "Stream nicht gefunden",
    "accessDenied": "Zugriff verweigert",
    "serverErr": "Serverfehler",
    "noContent": "Kein Inhalt gefunden",
    "selectCategory": "Kategorie wählen",
    "fetchingItems": "Hole Daten vom Portal.",
    "tryDifferent": "Wähle eine andere Kategorie oder lösche die Suche.",
    "now": "Jetzt",
    "loadEPG": "EPG laden",
    "noChannelsLoaded": "Keine Sender geladen",
    "noEPGData": "Keine EPG-Daten",
    "filterChannels": "Sender filtern…",
    "sendFeedback": "Feedback senden",
    "thankYou": "Danke!",
    "feedbackReceived": "Ihr Feedback wurde empfangen.",
    "feedbackHint": "Fehlerberichte, Funktionswünsche oder Kommentare",
    "feedbackPlaceholder": "Was beschäftigt Sie?",
    "sending": "Sende...",
    "noFavsYet": "Noch keine Favoriten",
    "favHint": "Klicke auf das ♡ Icon bei Sendern oder Filmen.",
    "liveTV": "Live TV",
    "nothingStarted": "Noch nichts gestartet",
    "resumeHint": "Inhalte ansehen, um sie hier fortzusetzen.",
    "resumeWatching": "Weiter ansehen",
    "recentlyWatched": "Zuletzt gesehen",
    "searchEverything": "Alles suchen",
    "searchHint": "Filme, Serien oder Sender",
    "settings": "Einstellungen"
  },
  "it": {
    "discover": "Scopri",
    "live": "TV dal vivo",
    "movies": "Film",
    "series": "Serie",
    "favorites": "Preferiti",
    "continueWatching": "Continua a guardare",
    "tvGuide": "Guida TV",
    "globalSearch": "Ricerca globale",
    "directPlay": "Riproduzione diretta",
    "watch": "Guarda",
    "tools": "Strumenti",
    "savedConns": "Connessioni salvate",
    "orAddNew": "o aggiungi nuova",
    "connect": "Connetti",
    "connectArrow": "Connetti →",
    "disconnect": "Disconnetti",
    "feedback": "Feedback",
    "send": "Invia",
    "cancel": "Annulla",
    "close": "Chiudi",
    "refresh": "Aggiorna",
    "search": "Cerca",
    "prev": "Prec.",
    "next": "Succ.",
    "fav": "Fav",
    "pip": "PiP",
    "play": "Riproduci",
    "go": "Vai",
    "playPause": "Play/Pausa",
    "fullscreen": "Schermo intero",
    "mute": "Muto",
    "channels": "Canali",
    "volume": "Volume",
    "portalURL": "URL del portale",
    "macAddress": "Indirizzo MAC",
    "serverURL": "URL del server",
    "username": "Nome utente",
    "password": "Password",
    "playlistURL": "URL della playlist",
    "connFailed": "Connessione fallita",
    "connecting": "Connessione in corso…",
    "import": "Importa",
    "xtreamCodes": "Xtream Codes",
    "m3uPlaylist": "Playlist M3U",
    "stalkerPortal": "Portale Stalker",
    "directHLS": "HLS diretto",
    "noChannels": "Nessun canale trovato",
    "loading": "Caricamento…",
    "loadingSection": "Caricamento {0}…",
    "playbackErr": "Errore di riproduzione",
    "networkErr": "Errore di rete",
    "streamNotFound": "Flusso non trovato",
    "accessDenied": "Accesso negato",
    "serverErr": "Errore del server",
    "noContent": "Nessun contenuto trovato",
    "selectCategory": "Seleziona una categoria",
    "fetchingItems": "Recupero elementi dal portale.",
    "tryDifferent": "Prova un'altra categoria o cancella la ricerca.",
    "now": "Ora",
    "loadEPG": "Carica EPG",
    "noChannelsLoaded": "Nessun canale caricato",
    "noEPGData": "Nessun dato EPG",
    "filterChannels": "Filtra canali…",
    "sendFeedback": "Invia Feedback",
    "thankYou": "Grazie!",
    "feedbackReceived": "Il tuo feedback è stato ricevuto.",
    "feedbackHint": "Segnalazioni bug, richieste funzioni o commenti",
    "feedbackPlaceholder": "Cosa hai in mente?",
    "sending": "Invio in corso...",
    "noFavsYet": "Ancora nessun preferito",
    "favHint": "Clicca l'icona ♡ su un canale o film.",
    "liveTV": "TV dal vivo",
    "nothingStarted": "Ancora nulla iniziato",
    "resumeHint": "Guarda dei contenuti per vederli qui.",
    "resumeWatching": "Continua a guardare",
    "recentlyWatched": "Visti di recente",
    "searchEverything": "Cerca ovunque",
    "searchHint": "Film, serie o canali",
    "settings": "Impostazioni"
  },
  "zh": {
    "discover": "发现",
    "live": "电视直播",
    "movies": "电影",
    "series": "连续剧",
    "favorites": "收藏夹",
    "continueWatching": "继续观看",
    "tvGuide": "节目表",
    "globalSearch": "全局搜索",
    "directPlay": "直接播放",
    "watch": "观看",
    "tools": "工具",
    "savedConns": "已保存的连接",
    "orAddNew": "或添加新连接",
    "connect": "连接",
    "connectArrow": "连接 →",
    "disconnect": "断开连接",
    "feedback": "反馈",
    "send": "发送",
    "cancel": "取消",
    "close": "关闭",
    "refresh": "刷新",
    "search": "搜索",
    "prev": "上一个",
    "next": "下一个",
    "fav": "收藏",
    "pip": "画中画",
    "play": "播放",
    "go": "去",
    "playPause": "播放/暂停",
    "fullscreen": "全屏",
    "mute": "静音",
    "channels": "频道",
    "volume": "音量",
    "portalURL": "门户网址",
    "macAddress": "MAC地址",
    "serverURL": "服务器网址",
    "username": "用户名",
    "password": "密码",
    "playlistURL": "播放列表网址",
    "connFailed": "连接失败",
    "connecting": "连接中…",
    "import": "导入",
    "xtreamCodes": "Xtream Codes",
    "m3uPlaylist": "M3U播放列表",
    "stalkerPortal": "Stalker门户",
    "directHLS": "直接HLS",
    "noChannels": "未找到频道",
    "loading": "加载中…",
    "loadingSection": "正在加载 {0}…",
    "playbackErr": "播放错误",
    "networkErr": "网络错误",
    "streamNotFound": "未找到流",
    "accessDenied": "拒绝访问",
    "serverErr": "服务器错误",
    "noContent": "未找到内容",
    "selectCategory": "选择一个分类",
    "fetchingItems": "正在从门户获取项目。",
    "tryDifferent": "尝试其他分类或清除搜索。",
    "now": "现在",
    "loadEPG": "加载节目表",
    "noChannelsLoaded": "未加载频道",
    "noEPGData": "没有节目表数据",
    "filterChannels": "过滤频道…",
    "sendFeedback": "发送反馈",
    "thankYou": "谢谢！",
    "feedbackReceived": "您的反馈已收到。",
    "feedbackHint": "错误报告、功能请求或一般评论",
    "feedbackPlaceholder": "您在想什么？",
    "sending": "正在发送...",
    "noFavsYet": "暂无收藏",
    "favHint": "点击频道或电影上的 ♡ 图标进行添加。",
    "liveTV": "电视直播",
    "nothingStarted": "尚未开始观看",
    "resumeHint": "观看内容后，它将出现在这里。",
    "resumeWatching": "继续观看",
    "recentlyWatched": "最近观看",
    "searchEverything": "搜索所有内容",
    "searchHint": "电影、连续剧或频道",
    "settings": "设置"
  },
  "ar": {
    "discover": "اكتشف",
    "live": "البث المباشر",
    "movies": "أفلام",
    "series": "مسلسلات",
    "favorites": "المفضلة",
    "continueWatching": "متابعة المشاهدة",
    "tvGuide": "دليل التلفزيون",
    "globalSearch": "بحث شامل",
    "directPlay": "تشغيل مباشر",
    "watch": "مشاهدة",
    "tools": "أدوات",
    "savedConns": "الاتصالات المحفوظة",
    "orAddNew": "أو أضف جديد",
    "connect": "اتصال",
    "connectArrow": "← اتصال",
    "disconnect": "قطع الاتصال",
    "feedback": "ملاحظات",
    "send": "إرسال",
    "cancel": "إلغاء",
    "close": "إغلاق",
    "refresh": "تحديث",
    "search": "بحث",
    "prev": "السابق",
    "next": "التالي",
    "fav": "مفضلة",
    "pip": "صورة في صورة",
    "play": "تشغيل",
    "go": "انطلق",
    "playPause": "تشغيل/إيقاف",
    "fullscreen": "ملء الشاشة",
    "mute": "كتم الصوت",
    "channels": "القنوات",
    "volume": "الصوت",
    "portalURL": "رابط البوابة",
    "macAddress": "عنوان MAC",
    "serverURL": "رابط الخادم",
    "username": "اسم المستخدم",
    "password": "كلمة المرور",
    "playlistURL": "رابط قائمة التشغيل",
    "connFailed": "فشل الاتصال",
    "connecting": "جارٍ الاتصال…",
    "import": "استيراد",
    "xtreamCodes": "Xtream Codes",
    "m3uPlaylist": "قائمة M3U",
    "stalkerPortal": "بوابة Stalker",
    "directHLS": "HLS مباشر",
    "noChannels": "لم يتم العثور على قنوات",
    "loading": "جارٍ التحميل…",
    "loadingSection": "جارٍ تحميل {0}…",
    "playbackErr": "خطأ في التشغيل",
    "networkErr": "خطأ في الشبكة",
    "streamNotFound": "البث غير موجود",
    "accessDenied": "الوصول مرفوض",
    "serverErr": "خطأ في الخادم",
    "noContent": "لم يتم العور على محتوى",
    "selectCategory": "اختر فئة",
    "fetchingItems": "جارٍ جلب العناصر من البوابة.",
    "tryDifferent": "جرّب فئة أخرى أو امسح البحث.",
    "now": "الآن",
    "loadEPG": "تحميل EPG",
    "noChannelsLoaded": "لا توجد قنوات محمّلة",
    "noEPGData": "لا توجد بيانات EPG",
    "filterChannels": "تصفية القنوات…",
    "sendFeedback": "إرسال ملاحظات",
    "thankYou": "شكراً لك!",
    "feedbackReceived": "تم استلام ملاحظاتك.",
    "feedbackHint": "تقارير الأخطاء أو طلبات الميزات أو التعليقات العامة",
    "feedbackPlaceholder": "ما الذي يدور في ذهنك؟",
    "sending": "جارٍ الإرسال...",
    "noFavsYet": "لا توجد مفضلات بعد",
    "favHint": "اضغط على أيقونة ♡ على أي قناة أو فيلم لإضافته هنا.",
    "liveTV": "البث المباشر",
    "nothingStarted": "لم تبدأ شيئاً بعد",
    "resumeHint": "شاهد بعض المحتوى وسيظهر هنا لاستئنافه بسهولة.",
    "resumeWatching": "استئناف المشاهدة",
    "recentlyWatched": "شوهد مؤخراً",
    "searchEverything": "بحث في كل شيء",
    "searchHint": "أفلام أو مسلسلات أو قنوات",
    "settings": "الإعدادات"
  },
  "pt": {
    "discover": "Descobrir",
    "live": "TV ao Vivo",
    "movies": "Filmes",
    "series": "Séries",
    "favorites": "Favoritos",
    "continueWatching": "Continuar Assistindo",
    "tvGuide": "Guia TV",
    "globalSearch": "Busca Global",
    "directPlay": "Reprodução Direta",
    "watch": "Assistir",
    "tools": "Ferramentas",
    "savedConns": "Conexiones Salvas",
    "orAddNew": "ou adicionar nova",
    "connect": "Conectar",
    "connectArrow": "Conectar →",
    "disconnect": "Desconectar",
    "feedback": "Feedback",
    "send": "Enviar",
    "cancel": "Cancelar",
    "close": "Fechar",
    "refresh": "Atualizar",
    "search": "Buscar",
    "prev": "Anterior",
    "next": "Próximo",
    "fav": "Fav",
    "pip": "PiP",
    "play": "Reproduzir",
    "go": "Ir",
    "playPause": "Reproduzir/Pausa",
    "fullscreen": "Tela Cheia",
    "mute": "Mudo",
    "channels": "Canais",
    "volume": "Volume",
    "portalURL": "URL do Portal",
    "macAddress": "Endereço MAC",
    "serverURL": "URL do Servidor",
    "username": "Usuário",
    "password": "Senha",
    "playlistURL": "URL da Playlist",
    "connFailed": "Falha na conexão",
    "connecting": "Conectando…",
    "import": "Importar",
    "xtreamCodes": "Xtream Codes",
    "m3uPlaylist": "Playlist M3U",
    "stalkerPortal": "Portal Stalker",
    "directHLS": "HLS Direct",
    "noChannels": "Nenhum canal encontrado",
    "loading": "Carregando…",
    "loadingSection": "Carregando {0}…",
    "playbackErr": "Erro de Reprodução",
    "networkErr": "Erro de Rede",
    "streamNotFound": "Transmissão Não Encontrada",
    "accessDenied": "Acesso Negado",
    "serverErr": "Erro do Servidor",
    "noContent": "Nenhum conteúdo encontrado",
    "selectCategory": "Selecione uma categoria",
    "fetchingItems": "Buscando itens do portal.",
    "tryDifferent": "Tente outra categoria ou limpe sua busca.",
    "now": "Agora",
    "loadEPG": "Carregar EPG",
    "noChannelsLoaded": "Nenhum canal carregado",
    "noEPGData": "Sem dados EPG",
    "filterChannels": "Filtrar canais…",
    "sendFeedback": "Enviar Feedback",
    "thankYou": "Obrigado!",
    "feedbackReceived": "Seu feedback foi recebido.",
    "feedbackHint": "Relatos de bugs, solicitações de recursos ou comentários gerais",
    "feedbackPlaceholder": "O que está em sua mente?",
    "sending": "Enviando...",
    "noFavsYet": "Nenhum favorito ainda",
    "favHint": "Clique no ícone ♡ em qualquer canal ou filme para adicioná-lo aqui.",
    "liveTV": "TV ao Vivo",
    "nothingStarted": "Nada iniciado ainda",
    "resumeHint": "Assista a algum conteúdo e ele aparecerá aqui.",
    "resumeWatching": "Continuar assistindo",
    "recentlyWatched": "Visto recentemente",
    "searchEverything": "Pesquisar tudo",
    "searchHint": "Filmes, Séries ou Canais",
    "settings": "Configurações"
  },
  "hi": {
    "discover": "खोजें",
    "live": "लाइव टीवी",
    "movies": "फ़िल्में",
    "series": "सीरीज़",
    "favorites": "पसंदीदा",
    "continueWatching": "देखना जारी रखें",
    "tvGuide": "टीवी गाइड",
    "globalSearch": "वैश्विक खोज",
    "directPlay": "डायरेक्ट प्ले",
    "watch": "देखें",
    "tools": "उपकरण",
    "savedConns": "सहेजे गए कनेक्शन",
    "orAddNew": "या नया जोड़ें",
    "connect": "कनेक्ट",
    "connectArrow": "कनेक्ट →",
    "disconnect": "डिस्कनेक्ट",
    "feedback": "प्रतिक्रिया",
    "send": "भेजें",
    "cancel": "रद्द करें",
    "close": "बंद करें",
    "refresh": "रीफ़्रेश",
    "search": "खोजें",
    "prev": "पिछला",
    "next": "अगला",
    "fav": "पसंद",
    "pip": "PiP",
    "play": "चलाएँ",
    "go": "जाएँ",
    "playPause": "चलाएँ/रोकें",
    "fullscreen": "फ़ुलस्क्रीन",
    "mute": "म्यूट",
    "channels": "चैनल",
    "volume": "ध्वनि",
    "portalURL": "पोर्टल URL",
    "macAddress": "MAC पता",
    "serverURL": "सर्वर URL",
    "username": "उपयोगकर्ता",
    "password": "पासवर्ड",
    "playlistURL": "प्लेलिस्ट URL",
    "connFailed": "कनेक्शन विफल",
    "connecting": "कनेक्ट हो रहा है…",
    "import": "आयात",
    "xtreamCodes": "Xtream Codes",
    "m3uPlaylist": "M3U प्लेलिस्ट",
    "stalkerPortal": "Stalker पोर्टल",
    "directHLS": "डायरेक्ट HLS",
    "noChannels": "कोई चैनल नहीं मिला",
    "loading": "लोड हो रहा है…",
    "loadingSection": "{0} लोड हो रहा है…",
    "playbackErr": "प्लेबैक त्रुटि",
    "networkErr": "नेटवर्क त्रुटि",
    "streamNotFound": "स्ट्रीम नहीं मिली",
    "accessDenied": "पहुँच अस्वीकृत",
    "serverErr": "सर्वर त्रुटि",
    "noContent": "कोई सामग्री नहीं मिली",
    "selectCategory": "एक श्रेणी चुनें",
    "fetchingItems": "पोर्टल से आइटम प्राप्त हो रहे हैं।",
    "tryDifferent": "कोई अन्य श्रेणी आज़माएँ या खोज साफ़ करें।",
    "now": "अभी",
    "loadEPG": "EPG लोड करें",
    "noChannelsLoaded": "कोई चैनल लोड नहीं हुआ",
    "noEPGData": "कोई EPG डेटा नहीं",
    "filterChannels": "चैनल फ़िल्टर करें…",
    "sendFeedback": "प्रतिक्रिया भेजें",
    "thankYou": "धन्यवाद!",
    "feedbackReceived": "आपकी प्रतिक्रिया प्राप्त हो गई है।",
    "feedbackHint": "बग रिपोर्ट, फ़ीचर अनुरोध, या सामान्य टिप्पणियाँ",
    "feedbackPlaceholder": "आपके मन में क्या है?",
    "sending": "भेजा जा रहा है...",
    "noFavsYet": "अभी तक कोई पसंदीदा नहीं",
    "favHint": "किसी भी चैनल या फ़िल्म पर ♡ आइकन पर क्लिक करें।",
    "liveTV": "लाइव टीवी",
    "nothingStarted": "अभी तक कुछ शुरू नहीं हुआ",
    "resumeHint": "कुछ सामग्री देखें और वह यहाँ दिखाई देगी।",
    "resumeWatching": "फिर से देखें",
    "recentlyWatched": "हाल ही में देखा गया",
    "searchEverything": "सब कुछ खोजें",
    "searchHint": "फ़िल्में, सीरीज़ या चैनल",
    "settings": "सेटिंग्स"
  },
  "ur": {
    "discover": "دریافت کریں",
    "live": "لائیو ٹی وی",
    "movies": "فلمیں",
    "series": "سیریز",
    "favorites": "پسندیدہ",
    "continueWatching": "دیکھنا جاری رکھیں",
    "tvGuide": "ٹی وی گائیڈ",
    "globalSearch": "عالمی تلاش",
    "directPlay": "براہ راست چلائیں",
    "watch": "دیکھیں",
    "tools": "ٹولز",
    "savedConns": "محفوظ کنکشنز",
    "orAddNew": "یا نیا شامل کریں",
    "connect": "جوڑیں",
    "connectArrow": "← جوڑیں",
    "disconnect": "منقطع کریں",
    "feedback": "رائے",
    "send": "بھیجیں",
    "cancel": "منسوخ",
    "close": "بند کریں",
    "refresh": "تازہ کریں",
    "search": "تلاش",
    "prev": "پچھلا",
    "next": "اگلا",
    "fav": "پسند",
    "pip": "PiP",
    "play": "چلائیں",
    "go": "جائیں",
    "playPause": "چلائیں/روکیں",
    "fullscreen": "فل سکرین",
    "mute": "خاموش",
    "channels": "چینلز",
    "volume": "آواز",
    "portalURL": "پورٹل URL",
    "macAddress": "MAC ایڈریس",
    "serverURL": "سرور URL",
    "username": "صارف نام",
    "password": "پاسورڈ",
    "playlistURL": "پلے لسٹ URL",
    "connFailed": "کنکشن ناکام",
    "connecting": "جوڑ رہے ہیں…",
    "import": "درآمد",
    "xtreamCodes": "Xtream Codes",
    "m3uPlaylist": "M3U پلے لسٹ",
    "stalkerPortal": "Stalker پورٹل",
    "directHLS": "براہ راست HLS",
    "noChannels": "کوئی چینل نہیں ملا",
    "loading": "لوڈ ہو رہا ہے…",
    "loadingSection": "{0} لوڈ ہو رہا ہے…",
    "playbackErr": "پلے بیک خرابی",
    "networkErr": "نیٹ ورک خرابی",
    "streamNotFound": "سٹریم نہیں ملی",
    "accessDenied": "رسائی سے انکار",
    "serverErr": "سرور خرابی",
    "noContent": "کوئی مواد نہیں ملا",
    "selectCategory": "زمرہ منتخب کریں",
    "fetchingItems": "پورٹل سے آئٹمز حاصل ہو رہے ہیں۔",
    "tryDifferent": "دوسرا زمرہ آزمائیں یا تلاش صاف کریں۔",
    "now": "ابھی",
    "loadEPG": "EPG لوڈ کریں",
    "noChannelsLoaded": "کوئی چینل لوڈ نہیں ہوا",
    "noEPGData": "کوئی EPG ڈیٹا نہیں",
    "filterChannels": "چینلز فلٹر کریں…",
    "sendFeedback": "رائے بھیجیں",
    "thankYou": "شکریہ!",
    "feedbackReceived": "آپ کی رائے موصول ہو گئی ہے۔",
    "feedbackHint": "بگ رپورٹس، فیچر درخواستیں، یا عمومی تبصرے",
    "feedbackPlaceholder": "آپ کے ذہن میں کیا ہے؟",
    "sending": "بھیج رہے ہیں...",
    "noFavsYet": "ابھی تک کوئی پسندیدہ نہیں",
    "favHint": "کسی भी چینل یا فلم پر ♡ آئیکن پر کلك کریں۔",
    "liveTV": "لائیو ٹی وی",
    "nothingStarted": "ابھی تک کچھ شروع نہیں ہوا",
    "resumeHint": "کچھ مواد دیکھیں اور یہ یہاں دکھائی دے گا۔",
    "resumeWatching": "دوبارہ دیکھیں",
    "recentlyWatched": "حال ہی میں دیکھا گیا",
    "searchEverything": "سب تلاش کریں",
    "searchHint": "فلمیں، سیریز یا چینلز",
    "settings": "ترتیبات"
  }
};
function _t(lang, key, ...args) { const s = LANGS[lang]?.[key] ?? LANGS.en[key] ?? key; return args.length ? s.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? "") : s; }

setEncKeySource(GUEST_ID);

// VAST functions are now in vast.js

// ── Adsterra Social Bar ──
const ADSTERRA_COOLDOWN_MS = 3 * 60 * 1000;
const ADSTERRA_STORAGE_KEY = "sv-adsterra-closed-at";

function AdsterraSocialBar({ onAllowedPage, isAdEligible }) {
  useEffect(() => {
    if (!ENABLE_ADSTERRA || !onAllowedPage || !isAdEligible) return;

    // ✅ Check cooldown BEFORE doing anything
    const closedAt = localStorage.getItem(ADSTERRA_STORAGE_KEY);
    if (closedAt && (Date.now() - parseInt(closedAt)) < ADSTERRA_COOLDOWN_MS) return;

    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = ADSTERRA_URL;
    script.async = true;
    document.head.appendChild(script);

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.removedNodes) {
          if (node.nodeType === 1) {
            const isAdBar =
              node.id?.startsWith("at_") ||
              node.className?.includes("adsterra") ||
              node.className?.includes("social-bar");

            if (isAdBar) {
              localStorage.setItem(ADSTERRA_STORAGE_KEY, Date.now().toString());
              observer.disconnect();
              // ✅ No setTicket — don't re-trigger the effect at all
            }
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      if (document.head.contains(script)) {
        document.head.removeChild(script);
      }
    };
  }, [onAllowedPage, isAdEligible]); // ✅ Only re-evaluate if the page eligibility changes

  return null;
}

// ── HilltopAds In-App Push ──
function HilltopPushAd({ onAllowedPage, isAdEligible }) {
  useEffect(() => {
    if (!ENABLE_HILLTOP || !onAllowedPage || !isAdEligible) return;

    const script = document.createElement("script");
    script.innerHTML = `
      (function(ntjo){
        var d = document,
            s = d.createElement('script'),
            l = d.scripts[d.scripts.length - 1];
        s.settings = ntjo || {};
        s.src = "//quarrelsomebitter.com/bZXCVus.dCGClN0XYMWvcM/neqmn9LudZDULlCkUPiT/c/w-Mlj_AQ0vNFDvE-tZNKzVA/yTMVDeQP0/NIQD";
        s.async = true;
        s.referrerPolicy = 'no-referrer-when-downgrade';
        l.parentNode.insertBefore(s, l);
      })({})
    `;
    document.head.appendChild(script);

    return () => {
      if (document.head.contains(script)) {
        document.head.removeChild(script);
      }
    };
  }, [onAllowedPage, isAdEligible]);

  return null;
}

// ── Reset Password Modal ──
function ResetPasswordModal({ token, onClose }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  async function submit(e) {
    e?.preventDefault();
    if (!password) return setErr("Password is required");
    if (password !== confirm) return setErr("Passwords do not match");
    setErr(""); setLoading(true);
    try {
      const res = await fetch(`${API}/api/auth/reset-password`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setDone(true);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }

  return (
    <div className="modal-ov">
      <div className="modal" style={{maxWidth:380}}>
        <div className="modal-title" style={{textAlign:"center",marginBottom:"1.5rem"}}>Reset Password</div>
        {done ? (
          <div style={{textAlign:"center"}}>
            <div style={{background:"rgba(0,212,255,0.1)",color:"var(--accent)",padding:".8rem",borderRadius:8,fontSize:".85rem",marginBottom:"1.5rem",border:"1px solid var(--accent-22)"}}>
              Password successfully reset! You can now log in with your new password.
            </div>
            <button className="btn-primary" onClick={onClose} style={{width:"100%"}}>Go to Login</button>
          </div>
        ) : (
          <form onSubmit={submit}>
            {err && <div className="err" style={{marginBottom:".8rem"}}>⚠ {err}</div>}
            <div className="fg">
              <label className="fl">New Password</label>
              <input className="fi" type="password" placeholder="New Password" value={password} onChange={e => setPassword(e.target.value)} autoFocus />
            </div>
            <div className="fg">
              <label className="fl">Confirm New Password</label>
              <input className="fi" type="password" placeholder="Confirm Password" value={confirm} onChange={e => setConfirm(e.target.value)} />
            </div>
            <div className="modal-btns" style={{marginTop:"1.5rem"}}>
              <button type="button" className="btn-cancel" onClick={onClose} disabled={loading} style={{flex:1}}>Cancel</button>
              <button type="submit" className="btn-confirm" disabled={loading} style={{flex:1}}>{loading ? "..." : "Reset"}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}



// Server sync — fire-and-forget with debounce (uses auth token if logged in)
const _syncTimers = {};
function syncToServer(type, connId, data) {
  const key = `${type}:${connId}`;
  clearTimeout(_syncTimers[key]);
  _syncTimers[key] = setTimeout(() => {
    authFetch(`${API}/api/sync/${type}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connId, data }),
    }).catch(() => {});
  }, 2000);
}

async function restoreFromServer(type, connId) {
  try {
    const res = await authFetch(`${API}/api/sync/${type}?connId=${encodeURIComponent(connId)}`);
    if (!res.ok) return null;
    const { data } = await res.json();
    return data;
  } catch { return null; }
}

// Restore connections from server (decrypt)
async function restoreConnectionsFromServer() {
  const data = await restoreFromServer("connections", "_all");
  return decryptConnections(data);
}

// Migrate guest data to authenticated user
async function migrateGuestData() {
  try {
    await authFetch(`${API}/api/sync/migrate-guest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guestId: GUEST_ID }),
    });
  } catch (e) { console.warn("Guest data migration failed:", e.message); }
}

async function syncConnectionSnapshotToServer(conns, options = {}) {
  const encrypted = await encryptConnections(conns);
  const res = await authFetch(API + "/api/sync/connections", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      connId: "_all",
      data: encrypted,
      count: conns.length,
      allowEmpty: options.allowEmpty === true,
      reason: options.reason,
    }),
  });
  if (!res.ok) throw new Error(`Connection sync failed (${res.status})`);
}

// ══════════════════════════════════════════════════════════════════
// THEMES (OTT Navigator style multi-theme)
// ══════════════════════════════════════════════════════════════════
const THEMES = {
  Dark:   { bg:"#07070f", s1:"#0f0f1c", s2:"#16162a", s3:"#1d1d35", accent:"#00d4ff", accent2:"#7c3aed", t1:"#dde0f5", t2:"#8080aa", t3:"#44445a" },
  Navy:   { bg:"#030b1a", s1:"#061228", s2:"#0d1f3c", s3:"#152850", accent:"#4da6ff", accent2:"#6c63ff", t1:"#d0e8ff", t2:"#6090b8", t3:"#304560" },
  AMOLED: { bg:"#000000", s1:"#0d0d0d", s2:"#181818", s3:"#222222", accent:"#ff6b35", accent2:"#ff2d55", t1:"#f0f0f0", t2:"#888888", t3:"#444444" },
  Forest: { bg:"#050f0a", s1:"#0a1f14", s2:"#112a1c", s3:"#1a3828", accent:"#00e896", accent2:"#00b4d8", t1:"#d0ffe8", t2:"#5a9070", t3:"#2a5038" },
  White:  { bg:"#ffffff", s1:"#f5f5f7", s2:"#ebebef", s3:"#dddde3", accent:"#0066ff", accent2:"#7c3aed", t1:"#1a1a2e", t2:"#5a5a72", t3:"#9a9ab0" },
  Bright: { bg:"#f8f9fc", s1:"#eef0f6", s2:"#e2e5ee", s3:"#d5d8e3", accent:"#e8364f", accent2:"#ff8c00", t1:"#1c1c28", t2:"#555568", t3:"#8888a0" },
};
const THEME_NAMES = Object.keys(THEMES);
const PROFILE_COLORS = ["#00d4ff","#ff6b35","#00e896","#ff2d55","#a78bfa","#fbbf24"];


// IndexedDB cache for large stalker data (avoids localStorage 5MB limit)
const idbCache = (() => {
  let dbP;
  function open() {
    if (dbP) return dbP;
    dbP = new Promise(r => {
      const req = indexedDB.open("sv-stalker-cache", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("c");
      req.onsuccess = () => r(req.result);
      req.onerror = () => r(null);
    });
    return dbP;
  }
  return {
    async get(key) {
      const d = await open(); if (!d) return null;
      return new Promise(r => { const g = d.transaction("c","readonly").objectStore("c").get(key); g.onsuccess = () => r(g.result ?? null); g.onerror = () => r(null); });
    },
    async set(key, val) {
      const d = await open(); if (!d) return;
      return new Promise(r => { const tx = d.transaction("c","readwrite"); tx.objectStore("c").put(val, key); tx.oncomplete = () => r(); tx.onerror = () => r(); });
    },
  };
})();

// Deterministic connection ID for IDB/D1 keying
function connId(c) {
  if (!c) return null;
  if (c.type === "stalker") return `stalker:${c.server}:${c.mac}`;
  if (c.type === "xtream") return `xtream:${c.server}:${c.user}`;
  if (c.type === "m3u") return `m3u:${c.url}`;
  return "hls";
}


// Migrate old idbCache/localStorage data to new permanent IDB keys
async function migrateOldCache() {
  try {
    const migrated = await idbCache.get("sv-migrated-v2");
    if (migrated) return;
    // Migrate old stalker category caches from localStorage
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("sv-s-") && key.includes("cats-")) {
        try {
          const { cats } = JSON.parse(localStorage.getItem(key));
          if (cats) {
            // Extract server from key: sv-s-{section}cats-{server}
            const match = key.match(/^sv-s-(vod|series)cats-(.+)$/);
            if (match) await idbCache.set(`cats-ls:${match[2]}:${match[1]}`, cats);
          }
        } catch (e) { console.warn("IDB/localStorage error:", e.message); }
      }
    }
    // Migrate old stalker channel caches (stored via db.set → localStorage)
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("sv-stalker-channels-")) {
        try {
          const channels = JSON.parse(localStorage.getItem(key));
          if (channels) {
            const server = key.replace("sv-stalker-channels-", "");
            await idbCache.set(`channels-ls:${server}`, channels);
          }
        } catch (e) { console.warn("IDB/localStorage error:", e.message); }
      }
    }
    await idbCache.set("sv-migrated-v2", true);
  } catch (e) { console.warn("IDB/localStorage error:", e.message); }
}
migrateOldCache();

// Cloud restore disabled — D1 catalog API handles persistence per-connection
// Future: restore connections list from D1 on first load

// ══════════════════════════════════════════════════════════════════
// UTILS
// ══════════════════════════════════════════════════════════════════
// parseM3U is now imported from utils.js

function parseXMLTV(xml) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const programs = {};
  doc.querySelectorAll("programme").forEach(p => {
    const ch = p.getAttribute("channel")?.toLowerCase().trim();
    if (!ch) return;
    const start = parseEPGDate(p.getAttribute("start"));
    const stop  = parseEPGDate(p.getAttribute("stop"));
    if (!programs[ch]) programs[ch] = [];
    programs[ch].push({ title: p.querySelector("title")?.textContent || "", start, stop });
  });
  return programs;
}

function parseEPGDate(s) {
  if (!s) return 0;
  const m = s.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) return 0;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`).getTime();
}

// getEPGNow and epgLookup are now imported from epg.js

// uid is now imported from utils.js

const STALKER_LIVE_TTL_MS = 30 * 24 * 60 * 60_000;
const STALKER_CATEGORY_TTL_MS = 24 * 60 * 60_000;
const STALKER_CATALOG_TTL_MS = 12 * 60 * 60_000;
const STALKER_LAZY_ENABLED = String(import.meta.env.VITE_STALKER_LAZY_CATALOG_ENABLED || '').toLowerCase() === 'true';

// Transform stalker item URL: extract direct HTTP URLs, store original as _stalkerCmd
function transformStalkerItem(item, portalBase) {
  const raw = (item.url || "").replace(/^(?:ffmpeg|ffrt)\s+/i, "").trim();
  const isDirect = raw.startsWith("http") && !raw.includes("localhost");
  const logo = item.logo ? (resolveUrl(item.logo, portalBase) || item.logo) : null;
  if (item._stalkerCmd !== undefined) return { ...item, logo };
  return { ...item, logo, _stalkerCmd: item.url, url: isDirect ? raw : null };
}

function annotateStalkerCatalogItem(item, request, group = undefined) {
  return {
    ...item,
    ...(group !== undefined ? { group } : {}),
    _stalkerCatalogRequest: {
      source: request.source || 'items',
      kind: request.kind,
      category: request.category || 'all',
      page: Number(request.page) || 1,
      pageSize: Number(request.pageSize) || 100,
      ...(request.query ? { query: request.query } : {}),
    },
  };
}

// ══════════════════════════════════════════════════════════════════
// CSS GENERATOR
// ══════════════════════════════════════════════════════════════════
// genCSS is now imported from utils.js


// ══════════════════════════════════════════════════════════════════

// CONNECTION MANAGER MODAL
// ══════════════════════════════════════════════════════════════════
const CONN_ICONS = { xtream:"📡", stalker:"📺", m3u:"📋", hls:"🔗" };

const ConnectionManager = memo(function ConnectionManager({ connections, activeConnId, onSwitch, onRemove, onAddNew, onClose, authUser, isGuest, onLogout, t: ct }) {
  const t = ct || ((k) => k);
  const [diagResults, setDiagResults] = useState({});
  const [diagLoading, setDiagLoading] = useState({});

  async function diagnose(c) {
    setDiagLoading(p => ({ ...p, [c.id]: true }));
    setDiagResults(p => ({ ...p, [c.id]: null }));
    const startTime = Date.now();
    try {
      const cfg = c.config || c;
      const body = { type: c.type };
      if (c.type === "stalker") { body.portal = cfg.portal || cfg.server; body.mac = cfg.mac; }
      else if (c.type === "xtream") { body.server = cfg.server; body.user = cfg.user; body.pass = cfg.pass; }
      else if (c.type === "m3u") { body.url = cfg.url; }
      const res = await fetch(`${API}/api/diagnose`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await res.json();
      setDiagResults(p => ({ ...p, [c.id]: data }));
      
      trackAnalytics("portal_connect", {
        provider_type: c.type,
        success: data.reachable ? "true" : "false",
        latency_ms: Date.now() - startTime,
        error_code: String(data.details?.status || data.details?.error || "unknown").slice(0, 50)
      });
    } catch (e) {
      setDiagResults(p => ({ ...p, [c.id]: { reachable: false, details: { error: e.message } } }));
      trackAnalytics("portal_connect", {
        provider_type: c.type,
        success: "false",
        latency_ms: Date.now() - startTime,
        error_code: String(e.message || "unknown").slice(0, 50)
      });
    }
    setDiagLoading(p => ({ ...p, [c.id]: false }));
  }

  return (
    <div className="modal-ov" onClick={e => e.target===e.currentTarget && onClose()}>
      <div className="modal" style={{maxWidth:"440px"}}>
        <div className="modal-title">{t("connections")}</div>
        {/* Logged-in user info */}
        {(authUser || isGuest) && (
          <div style={{display:"flex",alignItems:"center",gap:".6rem",padding:".5rem .7rem",marginBottom:".6rem",
            background:"var(--s2)",border:"1px solid var(--b1)",borderRadius:"8px"}}>
            <div style={{width:32,height:32,borderRadius:"50%",background:"var(--accent-22)",
              display:"flex",alignItems:"center",justifyContent:"center",fontSize:".85rem",flexShrink:0}}>
              {authUser ? authUser.username?.[0]?.toUpperCase() || "U" : "G"}
            </div>
            <div style={{flex:1,overflow:"hidden"}}>
              <div style={{fontSize:".8rem",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                {authUser ? authUser.username : "Guest"}
              </div>
              <div style={{fontSize:".6rem",color:"var(--t3)",textTransform:"capitalize"}}>
                {authUser ? `${authUser.role} · ${connections.length}/${authUser.maxConnections || authUser.limits?.maxConnections || "?"} connections` : "Guest mode · No sync"}
              </div>
            </div>
            {authUser && (
              <button style={{background:"none",border:"1px solid var(--b2)",borderRadius:4,cursor:"pointer",
                fontSize:".6rem",color:"var(--t3)",padding:".2rem .5rem"}}
                onClick={e => { e.stopPropagation(); onLogout(); onClose(); }}>
                Logout
              </button>
            )}
          </div>
        )}
        <div style={{display:"flex",flexDirection:"column",gap:".4rem",marginBottom:"1rem",maxHeight:"400px",overflowY:"auto"}}>
          {connections.map(c => {
            const diag = diagResults[c.id];
            const loading = diagLoading[c.id];
            return (
              <div key={c.id} style={{padding:".55rem .7rem",
                background: c.id===activeConnId ? "var(--accent)10" : "var(--s2)",
                border: `1px solid ${c.id===activeConnId ? "var(--accent)" : "var(--b2)"}`,
                borderLeft: `3px solid ${c.color}`,
                borderRadius:"8px",transition:"all .2s"}}>
                <div style={{display:"flex",alignItems:"center",gap:".6rem",cursor:"pointer"}}
                  onClick={() => { if (c.id !== activeConnId) onSwitch(c.id); }}>
                  <span style={{fontSize:"1rem"}}>{CONN_ICONS[c.type] || "📡"}</span>
                  <div style={{flex:1,overflow:"hidden"}}>
                    <div style={{fontSize:".8rem",fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.label}</div>
                    <div style={{fontSize:".65rem",color:"var(--t3)",textTransform:"capitalize"}}>{c.type}</div>
                  </div>
                  {c.id === activeConnId && <span style={{fontSize:".6rem",fontWeight:700,color:"var(--accent)",textTransform:"uppercase",letterSpacing:".05em"}}>{t("active")}</span>}
                  <button style={{background:"none",border:"1px solid var(--b2)",borderRadius:4,cursor:"pointer",fontSize:".65rem",color:"var(--t2)",padding:".15rem .4rem"}}
                    title="Diagnose connection"
                    onClick={e => { e.stopPropagation(); diagnose(c); }}>
                    {loading ? "..." : "🩺"}
                  </button>
                  {c.id !== activeConnId && (
                    <button onClick={e => { e.stopPropagation(); if(confirm(`Delete "${c.label}"?`)) onRemove(c.id); }}
                      style={{background:"none",border:"none",color:"var(--danger)",cursor:"pointer",fontSize:".75rem",padding:".2rem .3rem",
                        borderRadius:"4px",lineHeight:1,flexShrink:0}}
                      title={t("removeConn")}>✕</button>
                  )}
                </div>
                {diag && (
                  <div style={{marginTop:".4rem",padding:".35rem .5rem",background:"var(--s1)",borderRadius:6,fontSize:".65rem",lineHeight:1.6,fontFamily:"monospace"}}>
                    <span style={{color: (diag.valid ?? diag.reachable) ? "#4caf50" : "#f44336",fontWeight:700}}>
                      {diag.valid === false ? "Authentication failed" : diag.reachable ? "Reachable" : "Unreachable"}
                    </span>
                    {diag.latency != null && <span style={{color:"var(--t2)",marginLeft:".5rem"}}>{diag.latency}ms</span>}
                    {Object.entries(diag.details || {}).map(([k, v]) => (
                      <div key={k} style={{color:"var(--t3)"}}>{k}: <span style={{color:"var(--t2)"}}>{String(v)}</span></div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {connections.length === 0 && (
            <div style={{fontSize:".8rem",color:"var(--t3)",textAlign:"center",padding:"1rem"}}>{t("noSavedConns")}</div>
          )}
        </div>
        <div className="modal-btns">
          <button className="btn-cancel" onClick={onClose}>{t("close")}</button>
          <button className="btn-confirm" onClick={onAddNew}>{t("addConnection")}</button>
        </div>
      </div>
    </div>
  );
});

// ══════════════════════════════════════════════════════════════════
// EDIT CONNECTION MODAL
// ══════════════════════════════════════════════════════════════════
const EditConnectionModal = ({ conn, onClose, onSave, t }) => {
  const [type, setType] = useState(conn.type);
  const [label, setLabel] = useState(conn.label);
  const [form, setForm] = useState({});
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (conn.type === "stalker") {
      setForm({
        server: conn.config.server || "",
        mac: conn.config.mac || "",
        serial: conn.config.serial || "",
        deviceId: conn.config.deviceId || "",
        deviceId2: conn.config.deviceId2 || ""
      });
    } else if (conn.type === "xtream") {
      setForm({
        server: conn.config.server || "",
        user: conn.config.user || "",
        pass: conn.config.pass || ""
      });
    } else if (conn.type === "m3u") {
      setForm({
        url: conn.config.url || ""
      });
    }
  }, [conn]);

  const handleSave = async () => {
    setErr(""); setLoading(true);
    try {
      let finalConfig = {};
      if (type === "xtream") {
        if (!form.server || !form.user || !form.pass) throw new Error("All fields required");
        const server = form.server.trim().replace(/\/$/, "");
        const api = makeXtreamAPI(server, form.user, form.pass);
        const data = await api.auth();
        const status = String(data?.user_info?.status ?? "").trim().toLowerCase();
        if (data?.user_info?.auth !== 1 || ["disabled", "expired", "blocked", "suspended", "0"].includes(status)) throw new Error("Invalid credentials or disabled account");
        finalConfig = { type, server, user: form.user, pass: form.pass, info: data?.user_info };
      } else if (type === "m3u") {
        if (!form.url) throw new Error("Playlist URL required");
        const res = await proxyFetch(form.url.trim());
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!text.includes("#EXTM3U")) throw new Error("Not a valid M3U playlist");
        const channels = parseM3U(text);
        if (!channels.length) throw new Error("No channels found");
        finalConfig = { type, url: form.url, channels };
      } else if (type === "stalker") {
        if (!form.server || !form.mac) throw new Error("Portal URL and MAC required");
        const server = form.server.trim().replace(/\/$/, "");
        const macTrimmed = form.mac.trim();
        const serialTrimmed = form.serial?.trim() || undefined;
        const deviceIdTrimmed = form.deviceId?.trim() || undefined;
        const deviceId2Trimmed = (form.deviceId2?.trim() || form.deviceId?.trim()) || undefined;

        const validateBody = JSON.stringify({
          portal: server, mac: macTrimmed,
          serial: serialTrimmed, deviceId: deviceIdTrimmed, deviceId2: deviceId2Trimmed
        });

        const vRes = await fetch(`${API}/stalker/validate`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Guest-Id": GUEST_ID },
          body: validateBody
        });
        const v = await vRes.json();

        if (v.error && !v.portalReachable) throw new Error(v.error);
        if (v.status === "expired") throw new Error(`Account expired${v.expiry ? ` on ${v.expiry}` : ""}. Contact your provider.`);
        if (v.status === "blocked") throw new Error("Account is blocked. Contact your provider.");
        if (v.status === "suspended") throw new Error("Account is suspended. Contact your provider.");
        if (v.status === "unregistered") throw new Error("MAC address is not registered with this portal.");

        finalConfig = {
          server: server, mac: macTrimmed,
          serial: serialTrimmed, deviceId: deviceIdTrimmed, deviceId2: deviceId2Trimmed,
          accountInfo: v
        };
      }

      const updatedConn = {
        ...conn,
        label: label,
        type: type,
        config: finalConfig
      };

      onSave(updatedConn);
      onClose();
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-ov" onClick={e => e.target === e.currentTarget && !loading && onClose()}>
      <div className="modal" style={{ maxWidth: "440px" }}>
        <div className="modal-title">{t("editConnection")}</div>
        {err && <div className="err" style={{ marginBottom: "1rem" }}>⚠ {err}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem", marginBottom: "1rem", opacity: loading ? 0.6 : 1, pointerEvents: loading ? "none" : "auto" }}>
          <div>
            <label style={{ fontSize: ".7rem", color: "var(--t3)", display: "block", marginBottom: ".3rem" }}>{t("connectionName")}</label>
            <input
              type="text"
              value={label}
              onChange={e => setLabel(e.target.value)}
              style={{
                width: "100%",
                padding: ".5rem",
                border: "1px solid var(--b2)",
                borderRadius: "6px",
                background: "var(--s2)",
                color: "var(--t1)",
                fontSize: ".8rem"
              }}
            />
          </div>
          <div>
            <label style={{ fontSize: ".7rem", color: "var(--t3)", display: "block", marginBottom: ".3rem" }}>{t("connectionType")}</label>
            <select
              value={type}
              onChange={e => setType(e.target.value)}
              style={{
                width: "100%",
                padding: ".5rem",
                border: "1px solid var(--b2)",
                borderRadius: "6px",
                background: "var(--s2)",
                color: "var(--t1)",
                fontSize: ".8rem"
              }}
            >
              <option value="stalker">Stalker</option>
              <option value="xtream">Xtream</option>
              <option value="m3u">M3U</option>
            </select>
          </div>

          {type === "stalker" && (
            <>
              <div>
                <label style={{ fontSize: ".7rem", color: "var(--t3)", display: "block", marginBottom: ".3rem" }}>Server URL</label>
                <input
                  type="text"
                  value={form.server}
                  onChange={e => setForm({ ...form, server: e.target.value })}
                  style={{
                    width: "100%",
                    padding: ".5rem",
                    border: "1px solid var(--b2)",
                    borderRadius: "6px",
                    background: "var(--s2)",
                    color: "var(--t1)",
                    fontSize: ".8rem"
                  }}
                />
              </div>
              <div>
                <label style={{ fontSize: ".7rem", color: "var(--t3)", display: "block", marginBottom: ".3rem" }}>MAC Address</label>
                <input
                  type="text"
                  value={form.mac}
                  onChange={e => setForm({ ...form, mac: e.target.value })}
                  style={{
                    width: "100%",
                    padding: ".5rem",
                    border: "1px solid var(--b2)",
                    borderRadius: "6px",
                    background: "var(--s2)",
                    color: "var(--t1)",
                    fontSize: ".8rem"
                  }}
                />
              </div>
              {(form.serial || form.deviceId || form.deviceId2) && (
                <>
                  <div>
                    <label style={{ fontSize: ".7rem", color: "var(--t3)", display: "block", marginBottom: ".3rem" }}>Serial</label>
                    <input
                      type="text"
                      value={form.serial || ""}
                      onChange={e => setForm({ ...form, serial: e.target.value })}
                      style={{
                        width: "100%",
                        padding: ".5rem",
                        border: "1px solid var(--b2)",
                        borderRadius: "6px",
                        background: "var(--s2)",
                        color: "var(--t1)",
                        fontSize: ".8rem"
                      }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: ".7rem", color: "var(--t3)", display: "block", marginBottom: ".3rem" }}>Device ID</label>
                    <input
                      type="text"
                      value={form.deviceId || ""}
                      onChange={e => setForm({ ...form, deviceId: e.target.value })}
                      style={{
                        width: "100%",
                        padding: ".5rem",
                        border: "1px solid var(--b2)",
                        borderRadius: "6px",
                        background: "var(--s2)",
                        color: "var(--t1)",
                        fontSize: ".8rem"
                      }}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: ".7rem", color: "var(--t3)", display: "block", marginBottom: ".3rem" }}>Device ID 2</label>
                    <input
                      type="text"
                      value={form.deviceId2 || ""}
                      onChange={e => setForm({ ...form, deviceId2: e.target.value })}
                      style={{
                        width: "100%",
                        padding: ".5rem",
                        border: "1px solid var(--b2)",
                        borderRadius: "6px",
                        background: "var(--s2)",
                        color: "var(--t1)",
                        fontSize: ".8rem"
                      }}
                    />
                  </div>
                </>
              )}
            </>
          )}

          {type === "xtream" && (
            <>
              <div>
                <label style={{ fontSize: ".7rem", color: "var(--t3)", display: "block", marginBottom: ".3rem" }}>Server URL</label>
                <input
                  type="text"
                  value={form.server}
                  onChange={e => setForm({ ...form, server: e.target.value })}
                  style={{
                    width: "100%",
                    padding: ".5rem",
                    border: "1px solid var(--b2)",
                    borderRadius: "6px",
                    background: "var(--s2)",
                    color: "var(--t1)",
                    fontSize: ".8rem"
                  }}
                />
              </div>
              <div>
                <label style={{ fontSize: ".7rem", color: "var(--t3)", display: "block", marginBottom: ".3rem" }}>Username</label>
                <input
                  type="text"
                  value={form.user}
                  onChange={e => setForm({ ...form, user: e.target.value })}
                  style={{
                    width: "100%",
                    padding: ".5rem",
                    border: "1px solid var(--b2)",
                    borderRadius: "6px",
                    background: "var(--s2)",
                    color: "var(--t1)",
                    fontSize: ".8rem"
                  }}
                />
              </div>
              <div>
                <label style={{ fontSize: ".7rem", color: "var(--t3)", display: "block", marginBottom: ".3rem" }}>Password</label>
                <div style={{ display: "flex", position: "relative" }}>
                  <input
                    type={showPassword ? "text" : "password"}
                    value={form.pass}
                    onChange={e => setForm({ ...form, pass: e.target.value })}
                    style={{
                      width: "100%",
                      padding: ".5rem",
                      paddingRight: "2.5rem",
                      border: "1px solid var(--b2)",
                      borderRadius: "6px",
                      background: "var(--s2)",
                      color: "var(--t1)",
                      fontSize: ".8rem"
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    style={{
                      position: "absolute",
                      right: ".5rem",
                      top: "50%",
                      transform: "translateY(-50%)",
                      background: "none",
                      border: "none",
                      color: "var(--t3)",
                      cursor: "pointer",
                      fontSize: "1rem",
                      padding: 0
                    }}
                    title={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? "🙈" : "👁"}
                  </button>
                </div>
              </div>
            </>
          )}

          {type === "m3u" && (
            <div>
              <label style={{ fontSize: ".7rem", color: "var(--t3)", display: "block", marginBottom: ".3rem" }}>M3U URL</label>
              <input
                type="text"
                value={form.url}
                onChange={e => setForm({ ...form, url: e.target.value })}
                style={{
                  width: "100%",
                  padding: ".5rem",
                  border: "1px solid var(--b2)",
                  borderRadius: "6px",
                  background: "var(--s2)",
                  color: "var(--t1)",
                  fontSize: ".8rem"
                }}
              />
            </div>
          )}
        </div>
        <div className="modal-btns">
          <button className="btn-cancel" onClick={onClose} disabled={loading}>{t("cancel")}</button>
          <button className="btn-confirm" onClick={handleSave} disabled={loading}>{loading ? t("connecting") : t("apply")}</button>
        </div>
      </div>
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════
// CARD HELPERS
// ══════════════════════════════════════════════════════════════════
function FavBtn({ on, onClick, style={} }) {
  return (
    <button className={`fav-btn ${on?"on":""}`} style={style} title={on?"Remove from favorites":"Add to favorites"}
      onClick={e => { e.stopPropagation(); onClick(); }}>
      {on ? "♥" : "♡"}
    </button>
  );
}

// ══════════════════════════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════════════════════════
const NAV = [
  { key:"discover",  icon:"✨", tKey:"discover",          sKey:"watch" },
  { key:"live",      icon:"📺", tKey:"live",              sKey:"watch" },
  { key:"vod",       icon:"🎬", tKey:"movies",            sKey:"watch" },
  { key:"series",    icon:"📽", tKey:"series",            sKey:"watch" },
  { key:"favs",      icon:"♥",  tKey:"favorites",         sKey:"watch" },
  { key:"continue",  icon:"⏯",  tKey:"continueWatching",  sKey:"watch" },
  { key:"epg",       icon:"📋", tKey:"tvGuide",           sKey:"tools" },
  { key:"search",    icon:"🔍", tKey:"globalSearch",      sKey:"tools" },
  { key:"hls",       icon:"▶",  tKey:"directPlay",        sKey:"tools" },
  { key:"settings",  icon:"⚙",  tKey:"settings",          sKey:"tools" },
];

// ── MAIN APP ──
function ImportConfirmModal({ prompt, onCancel, onProceed, importing }) {
  if (!prompt) return null;
  const { items, failed } = prompt;
  return (
    <div className="modal-ov">
      <div className="modal" style={{ maxWidth: 520, maxHeight: "85vh", display: "flex", flexDirection: "column" }}>
        <div className="modal-title" style={{ textAlign: "center", marginBottom: ".4rem" }}>Import Issues Found</div>
        <div style={{ textAlign: "center", fontSize: ".8rem", opacity: .7, marginBottom: "1rem" }}>{failed.length} of {items.length} connection{failed.length > 1 ? "s" : ""} failed validation</div>
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: ".4rem", marginBottom: "1rem" }}>
          {failed.map(({ d, r }, i) => (
            <div key={i} style={{ padding: ".6rem .7rem", background: "rgba(255,45,85,0.08)", border: "1px solid rgba(255,45,85,0.3)", borderRadius: 8, fontSize: ".8rem" }}>
              <div style={{ display: "flex", gap: ".4rem", marginBottom: ".25rem" }}><span style={{ fontSize: ".65rem", fontWeight: 700, color: "var(--accent)", textTransform: "uppercase" }}>{d.type}</span><strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.label || d.server || d.url}</strong></div>
              <div style={{ color: "var(--err, #ff2d55)", fontSize: ".78rem" }}>⚠ {r.reason}</div>
            </div>
          ))}
        </div>
        <p style={{ textAlign: "center", fontSize: ".85rem", opacity: .7, marginBottom: "1rem" }}>Do you still want to import all {items.length} connections?</p>
        <div className="modal-btns"><button type="button" className="btn-cancel" onClick={onCancel} disabled={importing} style={{ flex: 1 }}>Cancel</button><button type="button" className="btn-confirm" onClick={onProceed} disabled={importing} style={{ flex: 1 }}>{importing ? "Importing..." : `Import ${items.length} Anyway`}</button></div>
      </div>
    </div>
  );
}
export default function App() {
  // ── auth state
  const [authUser, setAuthUser] = useState(null); // { id, username, role, limits }
  const [authLoading, setAuthLoading] = useState(true);
  const [isGuest, setIsGuest] = useState(false);
  const [resetToken, setResetToken] = useState(null);

  const liveGridRef = useRef(null);
  const stalkerCatalogApiRef = useRef(null);
  const stalkerCatalogCacheRef = useRef(null);
  const stalkerPageRef = useRef(new Map());

  // Check stored token on mount
  useEffect(() => {
    // Check for query params (activation, reset-password)
    const params = new URLSearchParams(window.location.search);
    const action = params.get("action");
    const tokenParam = params.get("token");

    if (action === "reset-password" && tokenParam) {
      setResetToken(tokenParam);
      // Clean up URL
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    if (isHttpContentMode()) { setAuthLoading(false); return; }

    const wasGuest = localStorage.getItem("sv-guest-mode") === "1";
    if (wasGuest) { setIsGuest(true); setAuthLoading(false); return; }
    // Check auth via httpOnly cookie
    fetch(`${API}/api/auth/me`, { credentials: "include" })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(async u => {
        setEncKeySource(`user:${u.id}`);
        // Merge server state with local state so a just-added connection is
        // not lost if setup reloads before the sync request finishes.
        const [serverConns, localConns] = await Promise.all([
          restoreConnectionsFromServer(),
          db.get("sv-connections", []),
        ]);
        const mergedConns = [...(serverConns || [])];
        for (const localConn of (localConns || [])) {
          if (!mergedConns.some(c => c.id === localConn.id)) mergedConns.push(localConn);
        }
        if (mergedConns.length) await db.set("sv-connections", mergedConns);
        setAuthUser(u);
      })
      .catch(() => { })
      .finally(() => setAuthLoading(false));
  }, []);

  async function handleAuth(user) {
    const guestConns = connections?.length ? [...connections] : [];

    setIsGuest(false); localStorage.removeItem("sv-guest-mode");
    // Use user ID for encryption key (consistent across devices)
    setEncKeySource(`user:${user.id}`);

    trackAnalytics("auth_success", {
      auth_method: "password",
      is_guest: false,
      guest_role: user.role || "regular",
    });
    
    // Migrate guest data to new user account (favs, history)
    await migrateGuestData();
    await clearStalkerOwnerCache(`guest:${GUEST_ID}`).catch(() => {});
    
    // Merge server state with local/guest state so recent additions survive
    // an auth transition while the server sync is completing.
    const serverConns = await restoreConnectionsFromServer();
    const mergedConns = [...(serverConns || [])];
    for (const localConn of guestConns) {
      if (!mergedConns.some(c => c.id === localConn.id)) mergedConns.push(localConn);
    }
    if (mergedConns.length) {
      setConnections(mergedConns, { sync: false });
    } else if (guestConns.length > 0) {
      // No server data, but we had guest connections — import them to the new account!
      setConnections(guestConns, { sync: false });
    } else {
      setConnections([], { sync: false });
    }
    const restoredConns = mergedConns.length ? mergedConns : guestConns;
    if (restoredConns.length) {
      await syncConnectionSnapshotToServer(restoredConns).catch(error => {
        console.warn("Connection sync after login failed:", error.message);
      });
    }
    setAuthUser(user);
  }
  async function handleGuest() {
    if (authUser?.id) await clearStalkerOwnerCache(`user:${authUser.id}`).catch(() => {});
    setIsGuest(true);
    localStorage.setItem("sv-guest-mode", "1");
    trackAnalytics("auth_success", {
      auth_method: "guest",
      is_guest: true,
      guest_role: "guest",
    });
  }
  async function handleLogout() {
    // Stop media before waiting on the network so logout cannot leave a
    // provider stream running behind a slow or failed auth request.
    cancelPlaybackResolve();
    setPlaying(null);
    localStorage.removeItem("sv-guest-mode");
    const ownerId = authUser?.id ? `user:${authUser.id}` : `guest:${GUEST_ID}`;
    abortStalkerCatalogRequests();
    await Promise.resolve(stalkerCatalogCacheRef.current?.clearOwner?.(ownerId)).catch(() => {});
    stalkerCatalogApiRef.current = null;
    stalkerCatalogCacheRef.current = null;
    stalkerPageRef.current.clear();
    await authFetch(`${API}/api/auth/logout`, { method: "POST" }).catch(() => {});
    clearContentSessionToken();
    setEphemeralConnection(null);
    // Clear current user's connections from local state
    setConnections([], { sync: false });
    setActiveConnId(null);
    setConn(null);
    db.set("sv-activeConn", null);
    setEncKeySource(GUEST_ID);
    setAuthUser(null); setIsGuest(false);
    if (httpContentMode) {
      navigateToAppHome({ location: window.location });
    }
  }
  const userRole = authUser?.role || (isGuest ? "guest" : null);
  const isAdEligible = isAdEligibleRole(userRole);
  const userLimits = authUser?.limits || (isGuest ? { maxConnections: 2, maxVod: 500, epg: true, sync: false } : null);

  const upgradePromptShown = useRef(false);

  // Show upgrade prompt for free/guest users on login
  useEffect(() => {
    if (!authLoading && (userRole === "free" || userRole === "guest") && !upgradePromptShown.current) {
      // Small delay to let the UI settle
      const timer = setTimeout(() => {
        setShowUpgradePrompt(true);
        upgradePromptShown.current = true;
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [authLoading, userRole]);

  // ── connection & data
  const [conn, setConn]       = useState(null);
  const [channels, setChannels] = useState([]);
  const [vod, setVod]         = useState([]);
  const [series, setSeries]   = useState([]);
  const [loading, setLoading] = useState(false);
  const [contentLoad, setContentLoad] = useState(null); // { value, label }
  const [vodSyncing, setVodSyncing] = useState(false);
  const [seriesSyncing, setSeriesSyncing] = useState(false);

  // ── series detail modal
  const [seriesDetail, setSeriesDetail] = useState(null); // {item, seasons, activeSeason}
  const [seriesLoading, setSeriesLoading] = useState(false);

  const getStalkerLazyTools = useCallback(async () => {
    if (!conn || conn.type !== "stalker") return null;
    const ownerId = authUser?.id ? `user:${authUser.id}` : `guest:${GUEST_ID}`;
    const connectionScope = {
      type: conn.type,
      server: conn.server,
      mac: conn.mac,
      serial: conn.serial,
      deviceId: conn.deviceId,
      deviceId2: conn.deviceId2,
    };
    const fingerprint = await stalkerCatalogConnectionFingerprint(connectionScope);
    const scopeKey = `${ownerId}:${fingerprint}`;
    if (!stalkerCatalogApiRef.current || stalkerCatalogApiRef.current.scopeKey !== scopeKey) {
      stalkerCatalogApiRef.current = { scopeKey, api: createStalkerCatalogApi({ fetcher: authFetch, enabled: STALKER_LAZY_ENABLED }) };
      stalkerCatalogCacheRef.current = await createStalkerCatalogCache({
        ownerId,
        connection: connectionScope,
      });
    }
    return { api: stalkerCatalogApiRef.current.api, cache: stalkerCatalogCacheRef.current };
  }, [authUser?.id, conn]);

  // ── upgrade prompt for free/guest users
  const [showUpgradePrompt, setShowUpgradePrompt] = useState(false);
  const [episodeLoading, setEpisodeLoading] = useState(null); // episode number being loaded
  const [expandedItem, setExpandedItem] = useState(null); // inline detail expansion for vod/series card
  const [tmdbData, setTmdbData] = useState(null);
  const [showTrailer, setShowTrailer] = useState(false);

  // ── ui state
  const [section, setSection] = useState(() => {
    const requested = new URLSearchParams(window.location.search).get("section");
    if (["discover", "live", "vod", "series", "favs", "continue", "epg", "search", "hls", "settings"].includes(requested)) return requested;
    try { return localStorage.getItem("sv-lastSection") ? JSON.parse(localStorage.getItem("sv-lastSection")) : "live"; } catch { return "live"; }
  });
  const [cat, setCat]         = useState("All");
  const [catSearch, setCatSearch] = useState("");
  const [search, setSearch]   = useState("");
  const deferredSearch = useDeferredValue(search);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;
  const [autoLoadMore, setAutoLoadMore] = useState(() => {
    try { return JSON.parse(localStorage.getItem("sv-autoLoadMore") || "true"); } catch { return true; }
  });
  const [globalQ, setGlobalQ] = useState("");
  const deferredGlobalQ = useDeferredValue(globalQ);
  const [playing, setPlaying] = useState(null);
  const [playbackLoading, setPlaybackLoading] = useState(null);
  const [ctx, setCtx]         = useState(null); // context menu {x,y,catName}
  const [showCatEditor, setShowCatEditor] = useState(null); // section name or null

  // ── theme
  const [themeName, setThemeName] = useState("Dark");

  // ── language (i18n)
  const [lang, setLang] = useState(() => {
    try { return localStorage.getItem("sv-lang") || "en"; } catch { return "en"; }
  });
  const t = useCallback((key, ...args) => _t(lang, key, ...args), [lang]);
  const isRTL = RTL_LANGS.includes(lang);
  const httpContentMode = isHttpContentMode();
  useEffect(() => {
    if (authLoading) return;
    const accountTier = isGuest ? "guest" : (authUser?.role || "unauthenticated");
    const screen = !authUser && !isGuest ? "auth" : (!conn ? "setup" : section);
    trackAnalyticsScreen(screen, {
      account_tier: accountTier,
      provider_type: conn?.type || "none",
      content_mode: httpContentMode,
    });
  }, [authLoading, authUser, isGuest, conn, section, httpContentMode]);

  const { state: sv, actions: svActions } = useStreamVault({
    db, syncToServer, syncConnectionsToServer: syncConnectionSnapshotToServer,
    connectionHydrationKey: authLoading
      ? null
      : authUser
        ? `user:${authUser.id}`
        : isGuest
          ? `guest:${GUEST_ID}`
          : null,
    authUser, isGuest,
    persistActiveConnId: !httpContentMode
  });

  const connections = sv.connections;
  const setConnections = svActions.setConnections;
  const activeConnId = sv.activeConnId;
  const setActiveConnId = svActions.setActiveConnId;
  const favs = sv.favorites;
  const setFavs = svActions.setFavorites;
  const history = sv.history;
  const historyRef = useRef(history);
  const lastHistoryLocalWriteRef = useRef(0);
  const lastHistoryServerSyncRef = useRef(0);
  const restoredSyncRef = useRef(null);
  useEffect(() => { historyRef.current = history; }, [history]);
  const setHistory = svActions.setHistory;

  const [showConnManager, setShowConnManager] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [editingConn, setEditingConn] = useState(null);
  const [contentSessionError, setContentSessionError] = useState("");
  const [contentSessionLoading, setContentSessionLoading] = useState(httpContentMode);
  const [contentSessionRetryKey, setContentSessionRetryKey] = useState(0);
  const [contentSessionOpening, setContentSessionOpening] = useState(false);
  const [importPrompt, setImportPrompt] = useState(null);
  const [importing, setImporting] = useState(false);
  const [ephemeralConnection, setEphemeralConnection] = useState(null);

  // ── hidden cats per section
  const [hiddenCats, setHiddenCats] = useState({live:[], vod:[], series:[]});

  // If current category becomes hidden, switch back to All
  useEffect(() => {
    if (cat !== "All" && isCatHidden(section, cat)) {
      setCat("All");
      setPage(1);
    }
  }, [hiddenCats, section, cat, isCatHidden]);

  useEffect(() => {
    if (!httpContentMode) {
      setEphemeralConnection(null);
      setContentSessionError("");
      setContentSessionLoading(false);
      return;
    }

    const controller = new AbortController();
    setContentSessionError("");
    setContentSessionLoading(true);

    (async () => {
      const result = await hydrateContentSession({
        signal: controller.signal,
        defaultColor: PROFILE_COLORS[0],
      });
      if (controller.signal.aborted || result.error === "cancelled") return;
      if (result.connection) {
        const normalizedConnection = result.connection;
        setContentSessionError("");
        setEphemeralConnection(normalizedConnection);
        setConn(normalizedConnection.config);
        setActiveConnId(normalizedConnection.id);
        setSection("live");
        setShowConnManager(false);
        setMobileMenuOpen(false);
        setEditingConn(null);
        setShowUpgradePrompt(false);
        cancelPlaybackResolve();
        setPlaying(null);
        setChannels([]);
        setVod([]);
        setSeries([]);
        setStalkerLiveCats([]);
        stalkerLiveCategoryRef.current = { id: "all", title: "All" };
        setCat("All");
        setSearch("");
        setGlobalQ("");
        setContentSessionLoading(false);
        return;
      }
      if (result.error === "session_auth_failure") return;
      setEphemeralConnection(null);
      setConn(null);
      setContentSessionError(result.error || "Content session expired or invalid");
      setContentSessionLoading(false);
    })();

    return () => controller.abort();
  }, [httpContentMode, contentSessionRetryKey, setActiveConnId]);

  useEffect(() => {
    if (!httpContentMode || !ephemeralConnection) return undefined;
    const token = contentSessionToken();
    if (!token) return undefined;
    let stopped = false;
    let refreshing = false;

    const refresh = async () => {
      if (stopped || refreshing) return;
      refreshing = true;
      try {
        await refreshContentSession(token);
      } catch (error) {
        const terminal = ["unauthorized", "invalid", "expired"].includes(error?.code)
          || [401, 403, 410].includes(error?.status);
        if (terminal && !stopped) {
          clearContentSessionToken();
          cancelPlaybackResolve();
          setPlaying(null);
          setConn(null);
          setEphemeralConnection(null);
          setContentSessionError(error?.message || "Content session expired or invalid");
        } else {
          console.warn("Content session keepalive failed:", error?.message || error);
        }
      } finally {
        refreshing = false;
      }
    };

    const timer = window.setInterval(refresh, 5 * 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { stopped = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [httpContentMode, ephemeralConnection]);

  // ── EPG
  const [epgURL, setEpgURL]   = useState("");
  const [epgSources, setEpgSources] = useState([]); // Array of { id, label, data }
  const [activeEpgSource, setActiveEpgSource] = useState("all");
  const [epgLoading, setEpgLoading] = useState(false);
  const epgLoadToken = useRef(0);
  const stalkerResolveRef = useRef(null); // Tracks current connection to ignore stale loads
  const playbackResolveCoordinatorRef = useRef(null);
  const playbackResolveGenerationRef = useRef(0);
  if (!playbackResolveCoordinatorRef.current) {
    playbackResolveCoordinatorRef.current = createPlaybackResolveCoordinator();
  }

  function cancelPlaybackResolve() {
    playbackResolveGenerationRef.current += 1;
    playbackResolveCoordinatorRef.current?.cancel();
    setPlaybackLoading(null);
  }

  async function runPlaybackResolve({ name, operation }) {
    const generation = ++playbackResolveGenerationRef.current;
    setPlaybackLoading({ name });
    try {
      return await playbackResolveCoordinatorRef.current.run(operation);
    } finally {
      if (generation === playbackResolveGenerationRef.current) setPlaybackLoading(null);
    }
  }

  function isPlaybackResolveCancellation(error) {
    return error?.code === "playback_resolve_cancelled" || error?.name === "AbortError";
  }

  useEffect(() => () => {
    playbackResolveGenerationRef.current += 1;
    playbackResolveCoordinatorRef.current?.cancel();
  }, []);

  const epgData = useMemo(() => {
    if (!epgSources.length) return null;
    let dataToProcess = null;

    if (activeEpgSource !== "all") {
      dataToProcess = epgSources.find(s => s.id === activeEpgSource)?.data || null;
    } else {
      const toMerge = epgSources.filter(s =>
        s.connectionId === activeConnId || s.kind !== "stalker"
      );
      if (!toMerge.length) return null;

      const merged = {};
      for (const source of toMerge) {
        if (!source.data) continue;
        for (const [chId, progs] of Object.entries(source.data)) {
          if (!merged[chId]) merged[chId] = [];
          merged[chId].push(...progs);
        }
      }
      dataToProcess = merged;
    }

    if (!dataToProcess) return null;

    const deduplicated = {};
    for (const [chId, progs] of Object.entries(dataToProcess)) {
      if (!progs || !progs.length) continue;

      const sorted = [...progs].sort((a, b) => {
        if (a.start === b.start) return b.stop - a.stop;
        return a.start - b.start;
      });

      const clean = [];
      for (const p of sorted) {
        const last = clean[clean.length - 1];
        if (
          last &&
          Math.abs(last.start - p.start) < 60000 &&
          (last.title || "").trim().toLowerCase() === (p.title || "").trim().toLowerCase()
        ) {
          continue;
        }
        clean.push({ ...p });
      }
      if (clean.length) deduplicated[chId] = clean;
    }

    return Object.keys(deduplicated).length ? deduplicated : null;
  }, [epgSources, activeEpgSource, activeConnId]);

  // Reset activeEpgSource if the selected source is no longer available
  useEffect(() => {
    if (activeEpgSource === "all") return;
    if (!epgSources.some(s => s.id === activeEpgSource)) {
      setActiveEpgSource("all");
    }
  }, [epgSources, activeEpgSource]);

  // Clear live state whenever connection changes (but preserve loaded EPG sources for the session)
  useEffect(() => {
    epgLoadToken.current++;
    setActiveEpgSource("all");
  }, [activeConnId]);

  // ── Stalker lazy-load
  const [stalkerLiveCats,   setStalkerLiveCats]   = useState([]); // [{id,title,count}]
  const [stalkerVodCats,    setStalkerVodCats]    = useState([]); // [{id,title,count}]
  const [stalkerSeriesCats, setStalkerSeriesCats] = useState([]); // [{id,title,count}]
  const [stalkerDiscoveryItems, setStalkerDiscoveryItems] = useState([]);
  const [stalkerDiscoveryLoading, setStalkerDiscoveryLoading] = useState(false);
  const [stalkerDiscoveryError, setStalkerDiscoveryError] = useState("");
  const [stalkerDiscoveryPartial, setStalkerDiscoveryPartial] = useState(false);
  const stalkerDiscoveryLoadedRef = useRef(null);
  const [catLoading,        setCatLoading]        = useState(false);
  const fetchingCatRef = useRef(new Set());
  const stalkerLiveCategoryRef = useRef({ id: "all", title: "All" });
  const stalkerCatalogRequestRef = useRef(null);
  const stalkerDiscoveryRequestRef = useRef(null);

  function beginStalkerCatalogRequest() {
    stalkerCatalogRequestRef.current?.abort();
    const controller = new AbortController();
    stalkerCatalogRequestRef.current = controller;
    return controller;
  }

  function abortStalkerCatalogRequests() {
    stalkerCatalogRequestRef.current?.abort();
    stalkerCatalogRequestRef.current = null;
    stalkerDiscoveryRequestRef.current?.abort();
    stalkerDiscoveryRequestRef.current = null;
    stalkerCatalogApiRef.current?.api?.abortScope?.();
  }

  async function clearStalkerOwnerCache(ownerId) {
    const current = stalkerCatalogCacheRef.current;
    if (current) {
      await current.clearOwner(ownerId);
      return;
    }
    const cache = await createStalkerCatalogCache({ ownerId });
    await cache.clearOwner(ownerId);
  }
  const prefetchProgress = null;

  // ── last synced timestamps
  const [lastSynced, setLastSynced] = useState({}); // {live: timestamp, vod: timestamp, series: timestamp}
  const [autoConnected, setAutoConnected] = useState(false); // true if loaded from IDB cache
  const [connError, setConnError] = useState(""); // Xtream auth or fetch error
  function beginContentLoad(label) {
    setContentLoad({ value: 8, label });
    setLoading(true);
  }

  function updateContentLoad(value, label) {
    setContentLoad(prev => ({ value, label: label || prev?.label || t("loading") }));
  }

  function endContentLoad() {
    setContentLoad(prev => prev ? { ...prev, value: 100 } : prev);
    setLoading(false);
  }

  // ── TMDB
  const [tmdbKey, setTmdbKey] = useState(() => localStorage.getItem("sv-tmdb-key") || "server");

  // ── Feedback widget
  const [fbOpen, setFbOpen] = useState(false);
  const [fbMsg, setFbMsg] = useState("");
  const [fbSending, setFbSending] = useState(false);
  const [fbDone, setFbDone] = useState(false);

  const sendFeedback = useCallback(async () => {
    if (!fbMsg.trim() || fbSending) return;
    setFbSending(true);

    trackAnalytics("user_feedback", {
      has_text: "true",
      feedback_type: "general",
      source_screen: section
    });

    try {
      await fetch(`${API}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Guest-Id": GUEST_ID },
        body: JSON.stringify({ message: fbMsg.trim(), guestId: GUEST_ID, timestamp: Date.now(), userAgent: navigator.userAgent }),
      });
    } catch (e) { console.warn("IDB/localStorage error:", e.message); }
    setFbSending(false);
    setFbMsg("");
    setFbDone(true);
    setTimeout(() => { setFbDone(false); setFbOpen(false); }, 1800);
  }, [fbMsg, fbSending, section]);

  // ── CSS injection
  useEffect(() => {
    const el = document.getElementById("sv-css") || (() => { const s = document.createElement("style"); s.id="sv-css"; document.head.appendChild(s); return s; })();
    el.textContent = genCSS(THEMES[themeName]);
  }, [themeName]);

  // ── Debounced Search for Analytics
  const debouncedSearch = useMemo(() => debounce((term, type) => {
    const queryLength = term.trim().length;
    if (queryLength > 0) trackAnalytics("search", {
      query_length: queryLength,
      source_screen: type
    });
  }, 1000), []);

  function handleSearch(term) {
    setSearch(term);
    setPage(1);
    debouncedSearch(term, "category");
  }

  function handleGlobalSearch(term) {
    setGlobalQ(term);
    debouncedSearch(term, "global");
  }

  // ── TMDB enrichment for detail modal
  useEffect(() => {
    if (!expandedItem || !tmdbKey) { setTmdbData(null); setShowTrailer(false); return; }

    function tmdbUrl(path, params = "") {
      if (tmdbKey === "server") return `${API}/api/tmdb/${path}?${params}`;
      return `https://api.themoviedb.org/3/${path}?api_key=${tmdbKey}&${params}`;
    }

    setTmdbData(null);
    setShowTrailer(false);
    const isMovie = expandedItem.type === "vod";
    const type = isMovie ? "movie" : "tv";
    const query = encodeURIComponent(expandedItem.name?.replace(/\s*\(\d{4}\)\s*$/, "").trim());
    const year = expandedItem.year ? `&year=${expandedItem.year}` : "";

    let cancelled = false;
    (async () => {
      try {
        const searchUrl = tmdbUrl(`search/${type}`, `query=${query}${year}&language=en-US`);
        const sr = await fetch(searchUrl).then(r => r.json());
        const match = sr.results?.[0];
        if (!match || cancelled) return;

        const [details, credits, videos] = await Promise.all([
          fetch(tmdbUrl(`${type}/${match.id}`, "language=en-US")).then(safeJsonFetch),
          fetch(tmdbUrl(`${type}/${match.id}/credits`)).then(safeJsonFetch).catch(() => null),
          fetch(tmdbUrl(`${type}/${match.id}/videos`, "language=en-US")).then(safeJsonFetch).catch(() => null),
        ]);
        if (cancelled) return;

        const trailer = videos?.results?.find(v => v.type === "Trailer" && v.site === "YouTube")
          || videos?.results?.find(v => v.site === "YouTube");

        setTmdbData({
          id: match.id,
          overview: details.overview || match.overview,
          poster: match.poster_path ? `https://image.tmdb.org/t/p/w342${match.poster_path}` : null,
          backdrop: match.backdrop_path ? `https://image.tmdb.org/t/p/w780${match.backdrop_path}` : null,
          genres: details.genres?.map(g => g.name) || [],
          runtime: details.runtime || (details.episode_run_time?.[0]) || null,
          tagline: details.tagline || null,
          voteAverage: details.vote_average || null,
          releaseDate: details.release_date || details.first_air_date || null,
          cast: credits?.cast?.slice(0, 6).map(c => ({
            name: c.name,
            character: c.character,
            photo: c.profile_path ? `https://image.tmdb.org/t/p/w185${c.profile_path}` : null,
          })) || [],
          director: credits?.crew?.find(c => c.job === "Director")?.name || null,
          trailer: trailer ? `https://www.youtube.com/embed/${trailer.key}` : null,
          trailerKey: trailer?.key || null,
        });
      } catch (e) { console.warn("IDB/localStorage error:", e.message); }
    })();
    return () => { cancelled = true; };
  }, [expandedItem, tmdbKey]);

  // ── load persisted data + auto-connect from IDB
  useEffect(() => {
    (async () => {
      // Migrate old profile/lastConn data to new connection system
      await migrateToConnections();

      const [th, hc, eq] = await Promise.all([
        db.get("sv-theme","Dark"),
        db.get("sv-hiddenCats",{live:[],vod:[],series:[]}),
        db.get("sv-epgURL",""),
      ]);
      if (THEME_NAMES.includes(th)) setThemeName(th);
      setHiddenCats(hc);
      if (eq) setEpgURL(eq);

      // Auto-connect: if we have an active connection, set conn (load cache if available)
      // Re-runs whenever activeConnId or connections change (both start as empty falsy values,
      // so this effect re-fires after useStreamVault populates them from IDB on mount)
      if (sv.hydrated && activeConnId && connections.length) {
        try {
          const connObj = connections.find(c => c.id === activeConnId);
          if (connObj) {
            if (lifecycleFailureMessage(connObj)) {
              setConn(null);
              return;
            }
            const cached = await loadFromCache(activeConnId, connObj);
            if (!cached) {
              // No cache, but active connection exists — set conn so app screen loads
              setConn(connObj.config);
            }
          }
        } catch (e) { console.warn("IDB/localStorage error:", e.message); }
      }
    })();
  }, [activeConnId, connections, sv.hydrated]); // re-run after persisted state is hydrated

  // ── restore from server when local favs/history are empty (fires after useStreamVault loads from db)
  useEffect(() => {
    if (!activeConnId || !sv.hydrated) return;
    const restoreKey = `${authUser?.id || (isGuest ? GUEST_ID : "guest")}:${activeConnId}`;
    if (restoredSyncRef.current === restoreKey) return;
    restoredSyncRef.current = restoreKey;
    let cancelled = false;
    (async () => {
      // Check if local favs/history are empty — if so, restore from server
      const favsEmpty = !sv.favorites
        || (Object.keys(sv.favorites.live||{}).length === 0
          && Object.keys(sv.favorites.vod||{}).length === 0
          && Object.keys(sv.favorites.series||{}).length === 0);
      const histEmpty = !sv.history || sv.history.length === 0;

      if (favsEmpty || histEmpty) {
        const [serverFavs, serverHist] = await Promise.all([
          favsEmpty ? restoreFromServer("favorites", activeConnId) : null,
          histEmpty ? restoreFromServer("history", activeConnId) : null,
        ]);
        if (cancelled) return;
        if (serverFavs && favsEmpty) svActions.setFavorites(serverFavs);
        if (serverHist && histEmpty) svActions.setHistory(serverHist);
      }
    })();
    return () => { cancelled = true; };
  }, [activeConnId, sv.hydrated, authUser?.id, isGuest]);

  // ── load cached content from IDB for a connection
  async function loadFromCache(id, connObj) {
    const cachedChannels = await idbCache.get(`content:${id}:live`);
    if (!Array.isArray(cachedChannels) || !cachedChannels.length) return false;

    const isStalker = connObj.type === "stalker";
    // Lazy Stalker catalogs have their own owner-scoped page cache. Do not
    // resurrect legacy aggregate arrays with stale playback references.
    if (isStalker && STALKER_LAZY_ENABLED) return false;
    const now = Date.now();
    let needsBackgroundRefresh = false;
    if (isStalker) {
      const cachedAt = await idbCache.get(`cachetime:content:${id}:live`);
      needsBackgroundRefresh = now - Number(cachedAt || 0) >= STALKER_LIVE_TTL_MS;
    }

    const normalizeCached = items => isStalker
      ? items.map(item => transformStalkerItem(item, connObj.config?.server || connObj.config?.portal))
      : items;
    const syncTs = await idbCache.get(`sync:${id}`);
    setChannels(normalizeCached(cachedChannels));

    const [cachedVod, cachedSeries] = await Promise.all([
      idbCache.get(`content:${id}:vod`),
      idbCache.get(`content:${id}:series`),
    ]);
    if (Array.isArray(cachedVod)) {
      setVod(normalizeCached(cachedVod));
      if (isStalker && now - Number(syncTs?.vod || 0) >= STALKER_CATALOG_TTL_MS) needsBackgroundRefresh = true;
    }
    if (Array.isArray(cachedSeries)) {
      setSeries(normalizeCached(cachedSeries));
      if (isStalker && now - Number(syncTs?.series || 0) >= STALKER_CATALOG_TTL_MS) needsBackgroundRefresh = true;
    }

    if (isStalker) {
      const [vodCategories, seriesCategories] = await Promise.all([
        Promise.all([idbCache.get(`cats:${id}:vod`), idbCache.get(`cachetime:cats:${id}:vod`)]),
        Promise.all([idbCache.get(`cats:${id}:series`), idbCache.get(`cachetime:cats:${id}:series`)]),
      ]);
      if (Array.isArray(vodCategories[0])) {
        setStalkerVodCats(vodCategories[0]);
        if (now - Number(vodCategories[1] || 0) >= STALKER_CATEGORY_TTL_MS) needsBackgroundRefresh = true;
      }
      if (Array.isArray(seriesCategories[0])) {
        setStalkerSeriesCats(seriesCategories[0]);
        if (now - Number(seriesCategories[1] || 0) >= STALKER_CATEGORY_TTL_MS) needsBackgroundRefresh = true;
      }
    }

    if (syncTs) setLastSynced(syncTs);
    setAutoConnected(!needsBackgroundRefresh);
    setConn(connObj.config);
    return true;
  }

  // ── migrate old profile/lastConn data to connection system
  async function migrateToConnections() {
    try {
      if (localStorage.getItem("sv-connections")) return; // already migrated
      const saved = localStorage.getItem("sv-lastConn");
      if (!saved) return;
      const lastConn = JSON.parse(saved);
      const cId = connId(lastConn);
      if (!cId) return;
      const color = PROFILE_COLORS[0];
      const label = lastConn.type === "xtream" ? `${lastConn.user} · Xtream`
        : lastConn.type === "stalker" ? `Stalker · ${(lastConn.mac||"").slice(-5)}`
        : lastConn.type === "m3u" ? `M3U · ${(lastConn.url||"").split("/").pop()?.slice(0,20)||"playlist"}`
        : "Direct HLS";
      const connObj = { id: cId, type: lastConn.type, label, color, config: lastConn };
      setConnections([connObj]);
      setActiveConnId(cId);
      // Migrate favorites: try active profile first, then default
      const ap = localStorage.getItem("sv-activeProfile");
      const activeProfileId = ap ? JSON.parse(ap) : "default";
      const oldFavs = localStorage.getItem(`sv-favs-${activeProfileId}`);
      if (oldFavs) {
        db.set(`sv-favs-${cId}`, JSON.parse(oldFavs));
      } else {
        const defFavs = localStorage.getItem("sv-favs-default");
        if (defFavs) db.set(`sv-favs-${cId}`, JSON.parse(defFavs));
      }
      // Migrate global history to per-connection
      const oldHistory = localStorage.getItem("sv-history");
      if (oldHistory) db.set(`sv-history-${cId}`, JSON.parse(oldHistory));
      // Clean up old keys
      localStorage.removeItem("sv-profiles");
      localStorage.removeItem("sv-activeProfile");
      localStorage.removeItem("sv-lastConn");
      localStorage.removeItem("sv-history");
    } catch (e) { console.warn("IDB/localStorage error:", e.message); }
  }

  // ── save theme
  useEffect(() => {
    db.set("sv-theme", themeName);
  }, [themeName]);

  // ── save language
  useEffect(() => {
    localStorage.setItem("sv-lang", lang);
  }, [lang]);

  useEffect(() => {
    localStorage.setItem("sv-autoLoadMore", JSON.stringify(autoLoadMore));
  }, [autoLoadMore]);

  // ── persist section to localStorage
  useEffect(() => {
    localStorage.setItem("sv-lastSection", JSON.stringify(section));
  }, [section]);

  // ── connection
  useEffect(() => {
    if (!conn) return;
    stalkerDiscoveryLoadedRef.current = null;
    setStalkerDiscoveryItems([]);
    setStalkerDiscoveryError("");
    setStalkerDiscoveryPartial(false);
    // If auto-connected from IDB cache, skip fetching from provider
    if (autoConnected) {
      setAutoConnected(false);
      // Still load EPG (transient, not cached)
      if (conn.type === "stalker") loadStalkerEPG();
      else if (conn.type === "xtream") {
        const xtreamEpgUrl = `${conn.server}/xmltv.php?username=${conn.user}&password=${conn.pass}`;
        loadEPG(xtreamEpgUrl);
      }
      else if (conn.epgUrl) loadEPG(conn.epgUrl);
      if (conn.type !== "stalker") return;
    }
    let cancelled = false;
    const controller = new AbortController();
    if (conn.type === "m3u") {
      // Activation does the single full download. The validation step only
      // checked a bounded chunk, so channels are not present here yet.
      (async () => {
        const cId = connId(conn);
        let cached = cId ? await idbCache.get(`content:${cId}:live`) : null;
        if (!cached?.length && conn.url) {
          try {
            const res = await proxyFetch(conn.url, { signal: controller.signal });
            if (!res.ok) throw new Error(`Playlist request failed (HTTP ${res.status})`);
            const text = await res.text();
            cached = parseM3U(text);
            if (cancelled) return;
            if (cId && cached?.length) {
              idbCache.set(`content:${cId}:live`, cached);
              const now = Date.now();
              setLastSynced(prev => {
                const next = { ...prev, live: now };
                idbCache.set(`sync:${cId}`, next);
                return next;
              });
            }
          } catch (e) {
            if (e?.name !== "AbortError") console.warn("M3U activation fetch failed:", e?.message || e);
          }
        }
        if (cancelled) return;
        const channels = conn.channels?.length ? conn.channels : (cached || []);
        setChannels(channels);
        const epgUrls = conn.epgUrls || (cached?.epgUrls ?? []) || (channels?.epgUrls ?? []);
        if (epgUrls?.length) epgUrls.forEach(u => loadEPG(u));
        else if (conn.epgUrl) loadEPG(conn.epgUrl);
      })();
    } else if (conn.type === "xtream") {
      fetchLive();
      // Load large VOD and series catalogs on demand when the user opens them.
      // Some providers return tens of megabytes for a full catalog.
      const xtreamEpgUrl = `${conn.server}/xmltv.php?username=${conn.user}&password=${conn.pass}`;
      loadEPG(xtreamEpgUrl);
    } else if (conn.type === "stalker") {
      (async () => {
        await loadInitialStalkerCatalog({
          loadChannels: () => fetchStalkerChannels(),
          // Keep the pre-existing background behavior when lazy catalogs are
          // disabled; only the lazy path loads the first VOD/series page here.
          loadVod: () => loadStalkerCats("vod", false, !STALKER_LAZY_ENABLED),
          loadSeries: () => loadStalkerCats("series", false, !STALKER_LAZY_ENABLED),
          isCancelled: () => cancelled,
        });
        // Keep EPG loading separate from the lazy catalog sequence so the
        // three catalog requests remain sequential without dropping the
        // existing Stalker TV-guide behavior.
        if (!cancelled) loadStalkerEPG();
      })().catch(error => {
        if (!cancelled && error?.name !== "AbortError" && error?.code !== "ABORT_ERR") console.error("Stalker catalog loading failed:", error);
      });
    }
    return () => {
      cancelled = true;
      controller.abort();
      abortStalkerCatalogRequests();
    };
  }, [conn]);

  async function fetchLive(force = false) {
    if (!conn || conn.type !== "xtream") return;
    const cId = connId(conn);
    // Check IDB first (unless force refresh)
    if (!force && cId) {
      const cached = await idbCache.get(`content:${cId}:live`);
      if (cached && cached.length) { setChannels(cached); return; }
    }
    beginContentLoad("Connecting to live channels");
    try {
      const api = makeXtreamAPI(conn.server, conn.user, conn.pass);
      const [catData, sd] = await Promise.all([api.getLiveCategories(), api.getLive()]);
      updateContentLoad(62, "Processing live channels…");
      const cm = Object.fromEntries(catData.map(c => [c.category_id, c.category_name]));
      const items = sd.map(s => ({ id:String(s.stream_id), name:s.name, logo:s.stream_icon,
        group:cm[s.category_id]||"Other", url:api.liveURL(s.stream_id), num:s.num, epgId:s.epg_channel_id, type:"live" }));
      setChannels(items);
      // Persist to IDB + D1
      if (cId) {
        idbCache.set(`content:${cId}:live`, items);
        const now = Date.now();
        setLastSynced(prev => { const n = { ...prev, live: now }; idbCache.set(`sync:${cId}`, n); return n; });
      }
    } catch(e) { console.error(e); setConnError(e.message); }
    finally { endContentLoad(); }
  }

  async function fetchVOD(force = false, background = false) {
    if (!conn || conn.type !== "xtream") return;
    
    // Prevent overlapping requests if a sync is already happening
    if (vodSyncing && !background) return;

    const cId = connId(conn);
    // Check IDB first (unless force refresh)
    if (!force && cId && !vod.length) {
      const cached = await idbCache.get(`content:${cId}:vod`);
      if (cached && cached.length) { setVod(cached); return; }
    }
    if (!force && vod.length) return;
    
    if (!background) beginContentLoad("Loading movies");
    else setVodSyncing(true);

    try {
      const api = makeXtreamAPI(conn.server, conn.user, conn.pass);
      const [catData, sd] = await Promise.all([api.getVODCategories(), api.getVOD()]);
      if (!background) updateContentLoad(62, "Processing movies…");
      const cm = Object.fromEntries(catData.map(c => [c.category_id, c.category_name]));
      const items = sd.map(s => ({ id:String(s.stream_id), name:s.name, logo:s.stream_icon,
        group:cm[s.category_id]||"Other", url:api.vodURL(s.stream_id, s.container_extension||"mp4"),
        year:s.year, rating:s.rating, type:"vod",
        plot:s.plot||s.description||null, genre:s.genre||null, director:s.director||null,
        actors:s.actors||s.cast||null, duration:s.duration||null, country:s.country||null }));
      setVod(items);
      if (cId) {
        idbCache.set(`content:${cId}:vod`, items);
        const now = Date.now();
        setLastSynced(prev => { const n = { ...prev, vod: now }; idbCache.set(`sync:${cId}`, n); return n; });
      }
    } catch(e) { console.error(e); setConnError(e.message); }
    finally { 
      if (!background) endContentLoad();
      else setVodSyncing(false);
    }
  }

  async function fetchSeries(force = false, background = false) {
    if (!conn || conn.type !== "xtream") return;

    // Prevent overlapping requests
    if (seriesSyncing && !background) return;

    const cId = connId(conn);
    if (!force && cId && !series.length) {
      const cached = await idbCache.get(`content:${cId}:series`);
      if (cached && cached.length) { setSeries(cached); return; }
    }
    if (!force && series.length) return;
    
    if (!background) beginContentLoad("Loading series");
    else setSeriesSyncing(true);

    try {
      const api = makeXtreamAPI(conn.server, conn.user, conn.pass);
      const [catData, sd] = await Promise.all([api.getSeriesCategories(), api.getSeries()]);
      if (!background) updateContentLoad(62, "Processing series…");
      const cm = Object.fromEntries(catData.map(c => [c.category_id, c.category_name]));
      const items = sd.map(s => ({ id:String(s.series_id), name:s.name, logo:s.cover,
        group:cm[s.category_id]||"Other", year:s.releaseDate?.slice(0,4), rating:s.rating, type:"series",
        plot:s.plot||s.description||null, genre:s.genre||null, director:s.director||null,
        actors:s.actors||s.cast||null, country:s.country||null }));
      setSeries(items);
      if (cId) {
        idbCache.set(`content:${cId}:series`, items);
        const now = Date.now();
        setLastSynced(prev => { const n = { ...prev, series: now }; idbCache.set(`sync:${cId}`, n); return n; });
      }
    } catch(e) { console.error(e); setConnError(e.message); }
    finally { 
      if (!background) endContentLoad();
      else setSeriesSyncing(false);
    }
  }

  function stalkerRequestParams(extra = {}) {
    const params = new URLSearchParams(extra);
    const sessionToken = contentSessionToken();
    if (sessionToken) params.set("contentToken", sessionToken);
    else {
      params.set("portal", conn.server);
      params.set("mac", conn.mac);
      if (conn.serial) params.set("serial", conn.serial);
      if (conn.deviceId) params.set("deviceId", conn.deviceId);
      if (conn.deviceId2) params.set("deviceId2", conn.deviceId2);
    }
    return params.toString();
  }

  async function loadStalkerLiveCategoryItems(categoryId, categoryTitle, force = false, silent = false) {
    const category = String(categoryId || "all");
    const title = String(categoryTitle || "All");
    const refKey = `live-${category}`;
    if (fetchingCatRef.current.has(refKey)) return;
    fetchingCatRef.current.add(refKey);
    stalkerLiveCategoryRef.current = { id: category, title };
    setPage(1);
    if (!silent) beginContentLoad(`Loading ${title}`);
    try {
      const tools = await getStalkerLazyTools();
      const controller = beginStalkerCatalogRequest();
      const request = { kind: "live", category, page: 1, pageSize: 100, contentToken: contentSessionToken(), refresh: force };
      if (force) await tools.cache.invalidateScope({ kind: "live", category });
      const cached = !force ? await tools.cache.getPage(request) : null;
      if (cached?.stale) {
        const staleItems = cached.items.map(item => transformStalkerItem(
          annotateStalkerCatalogItem({ ...item, url: item.playRef }, request, title),
          conn.server,
        ));
        setChannels(staleItems);
      }
      const data = cached && !cached.stale
        ? cached
        : await tools.api.fetchCatalogPage({ ...request, signal: controller.signal });
      if (!cached || cached.stale) await tools.cache.putPage(data);
      if (!silent) updateContentLoad(72, describeStalkerCatalogLoading({ kind: "live", capabilities: data.capabilities }));
      const items = data.items.map(item => transformStalkerItem(
        annotateStalkerCatalogItem({ ...item, url: item.playRef }, request, title),
        conn.server,
      ));
      setCat(title);
      setChannels(items);
      stalkerPageRef.current.set(`live:${category}`, {
        nextPage: data.nextPage,
        hasMore: data.hasMore,
        loading: false,
        total: data.total,
        totalKnown: data.totalKnown,
        complete: data.complete,
        capabilities: data.capabilities,
      });
      setLastSynced(prev => ({ ...prev, live: Date.now() }));
    } catch (e) {
      if (e?.name !== "AbortError" && e?.code !== "ABORT_ERR") {
        console.error("Stalker lazy live category error:", e);
        setConnError(formatStalkerCatalogError(e));
      }
    } finally {
      if (!silent) endContentLoad();
      fetchingCatRef.current.delete(refKey);
    }
  }

  async function fetchStalkerChannels(force = false) {
    if (!conn || conn.type !== "stalker") return;
    if (STALKER_LAZY_ENABLED) {
      beginContentLoad("Loading live channels");
      try {
        const tools = await getStalkerLazyTools();
        const controller = beginStalkerCatalogRequest();
        const cachedCategories = !force ? await tools.cache.getCategories("live") : null;
        if (cachedCategories?.stale) setStalkerLiveCats(cachedCategories.categories || []);
        const categoryResponse = cachedCategories && !cachedCategories.stale
          ? cachedCategories
          : await tools.api.fetchCategories({ kind: "live", contentToken: contentSessionToken(), refresh: force, signal: controller.signal });
        if (!cachedCategories || cachedCategories.stale || force) await tools.cache.putCategories("live", categoryResponse);
        const categories = categoryResponse.categories || [];
        setStalkerLiveCats(categories);
        const current = stalkerLiveCategoryRef.current;
        const selected = (force || current.id !== "all")
          ? categories.find(item => String(item.id) === String(current.id))
          : null;
        const firstCategory = selected || categories.find(item => String(item.id) !== "all") || categories[0] || { id: "all", title: "All" };
        await loadStalkerLiveCategoryItems(firstCategory.id, firstCategory.title, force, true);
      } catch (e) { if (e?.name !== "AbortError" && e?.code !== "ABORT_ERR") { console.error("Stalker lazy channels error:", e); setConnError(formatStalkerCatalogError(e)); } }
      finally { endContentLoad(); }
      return;
    }
    const cId = connId(conn);
    // Stalker channel catalogs expire after six hours.
    if (!force && cId) {
      const cacheKey = `content:${cId}:live`;
      const [cached, cachedAt] = await Promise.all([idbCache.get(cacheKey), idbCache.get(`cachetime:${cacheKey}`)]);
      if (cached?.length && Date.now() - Number(cachedAt || 0) < STALKER_LIVE_TTL_MS) { setChannels(cached); return; }
    }
    beginContentLoad("Connecting to Stalker portal");
    try {
      const res = await fetch(`${API}/stalker/channels?${stalkerRequestParams(force ? { refresh: "1" } : {})}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      updateContentLoad(62, "Processing live channels…");
      const items = (data.channels || []).map(item => transformStalkerItem(item, conn.server));
      setChannels(items);
      // Persist stable channel data to IDB + D1
      if (cId) {
        const cacheKey = `content:${cId}:live`;
        idbCache.set(cacheKey, items.map(item => stripTransientStreamFields(item)));
        idbCache.set(`cachetime:${cacheKey}`, Date.now());
        const now = Date.now();
        setLastSynced(prev => { const n = { ...prev, live: now }; idbCache.set(`sync:${cId}`, n); return n; });
      }
    } catch(e) { console.error("Stalker channels error:", e); }
    finally { endContentLoad(); }
  }

  // ── Load category lists with a bounded IndexedDB TTL
  // background=true: don't touch setCat/setLoading (used for pre-fetching on connect)
  async function loadStalkerCats(sec, force = false, background = false) {
    if (STALKER_LAZY_ENABLED) {
      const kind = sec === "vod" ? "vod" : "series";
      try {
        const tools = await getStalkerLazyTools();
        const controller = beginStalkerCatalogRequest();
        if (force) await tools.cache.invalidateScope({ kind, });
        const cachedCategories = !force ? await tools.cache.getCategories(kind) : null;
        if (cachedCategories?.stale) {
          const staleCats = cachedCategories.categories || [];
          kind === "vod" ? setStalkerVodCats(staleCats) : setStalkerSeriesCats(staleCats);
        }
        const categoryResponse = cachedCategories && !cachedCategories.stale
          ? cachedCategories
          : await tools.api.fetchCategories({ kind, contentToken: contentSessionToken(), refresh: force, signal: controller.signal });
        if (!cachedCategories || cachedCategories.stale || force) {
          await tools.cache.putCategories(kind, categoryResponse);
        }
        const cats = categoryResponse.categories || [];
        kind === "vod" ? setStalkerVodCats(cats) : setStalkerSeriesCats(cats);
        if (!background && cats.length) {
          setCat(cats[0].title);
          await loadStalkerCatItems(sec, cats[0].id, cats[0].title, false, force);
        }
      } catch (e) { if (e?.name !== "AbortError" && e?.code !== "ABORT_ERR") { console.error(`Stalker lazy ${sec} categories:`, e); setConnError(formatStalkerCatalogError(e)); } }
      return;
    }
    const cId = connId(conn);
    let cats = null;
    if (!force && cId) {
      try {
        const cacheKey = `cats:${cId}:${sec}`;
        const [cached, cachedAt] = await Promise.all([idbCache.get(cacheKey), idbCache.get(`cachetime:${cacheKey}`)]);
        if (cached?.length && Date.now() - Number(cachedAt || 0) < STALKER_CATEGORY_TTL_MS) cats = cached;
      } catch (e) { console.warn("IDB/localStorage error:", e.message); }
    }
    if (!cats) {
      if (!background) beginContentLoad("Loading categories");
      try {
        const res  = await fetch(`${API}/stalker/${sec}/categories?${stalkerRequestParams(force ? { refresh: "1" } : {})}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        if (!background) updateContentLoad(52, "Loading categories…");
        cats = data.categories || [];
        // Save categories to IDB + D1
        if (cId) {
          const cacheKey = `cats:${cId}:${sec}`;
          idbCache.set(cacheKey, cats);
          idbCache.set(`cachetime:${cacheKey}`, Date.now());
        }
      } catch(e) { console.error(`Stalker ${sec} cats:`, e); return; }
      finally { if (!background) endContentLoad(); }
    }
    sec === "vod" ? setStalkerVodCats(cats) : setStalkerSeriesCats(cats);
    if (cats.length) {
      if (!background) {
        setCat(cats[0].title);
        await loadStalkerCatItems(sec, cats[0].id, cats[0].title, false, force);
      }
    }
  }

  // ── Load items for one Stalker category with a bounded IndexedDB TTL
  async function loadStalkerCatItems(sec, catId, catTitle, silent = false, force = false) {
    if (STALKER_LAZY_ENABLED) {
      const kind = sec === "vod" ? "vod" : "series";
      const refKey = `${sec}-${catId}`;
      if (fetchingCatRef.current.has(refKey)) return;
      fetchingCatRef.current.add(refKey);
      const useGlobalLoader = shouldUseGlobalCatalogLoader({ lazyCatalogEnabled: STALKER_LAZY_ENABLED, kind });
      if (!silent) {
        setCatLoading(true);
        if (useGlobalLoader) beginContentLoad(`Loading ${kind === "vod" ? "movies" : "series"}`);
      }
      try {
        const tools = await getStalkerLazyTools();
        const controller = beginStalkerCatalogRequest();
        const request = { kind, category: String(catId), page: 1, pageSize: 100, contentToken: contentSessionToken(), refresh: force };
        if (force) await tools.cache.invalidateScope({ kind, category: String(catId) });
        const cached = !force ? await tools.cache.getPage(request) : null;
        if (cached?.stale) {
          const staleItems = cached.items.map(item => transformStalkerItem(annotateStalkerCatalogItem({ ...item, url: item.playRef }, request, catTitle), conn.server));
          if (kind === "vod") setVod(prev => [...prev.filter(item => item.group !== catTitle), ...staleItems]);
          else setSeries(prev => [...prev.filter(item => item.group !== catTitle), ...staleItems]);
        }
        const data = cached && !cached.stale ? cached : await tools.api.fetchCatalogPage({ ...request, signal: controller.signal });
        if (!cached || cached.stale) await tools.cache.putPage(data);
        const mapped = data.items.map(item => transformStalkerItem(annotateStalkerCatalogItem({ ...item, url: item.playRef }, request, catTitle), conn.server));
        if (kind === "vod") setVod(prev => [...prev.filter(item => item.group !== catTitle), ...mapped]);
        else setSeries(prev => [...prev.filter(item => item.group !== catTitle), ...mapped]);
        stalkerPageRef.current.set(`${kind}:${catId}`, { nextPage: data.nextPage, hasMore: data.hasMore, loading: false, total: data.total, totalKnown: data.totalKnown, complete: data.complete, capabilities: data.capabilities });
      } catch (e) { if (e?.name !== "AbortError" && e?.code !== "ABORT_ERR") { console.error(`Stalker lazy ${sec} items:`, e); setConnError(formatStalkerCatalogError(e)); } }
      finally {
        if (!silent) {
          setCatLoading(false);
          if (useGlobalLoader) endContentLoad();
        }
        fetchingCatRef.current.delete(refKey);
      }
      return;
    }
    const refKey = `${sec}-${catId}`;
    if (fetchingCatRef.current.has(refKey)) return;
    fetchingCatRef.current.add(refKey);
    const cId = connId(conn);
    const CACHE_KEY = cId ? `catitems:${cId}:${sec}:${catId}` : `sv-s-${sec}item-${conn.server}-${catId}`;
    const applyItems = (items) => {
      const mapped = items.map(item => ({ ...transformStalkerItem(item, conn.server), group: catTitle }));
      if (sec === "vod") setVod(prev => [...prev.filter(v => v.group !== catTitle), ...mapped]);
      else setSeries(prev => [...prev.filter(s => s.group !== catTitle), ...mapped]);

    };
    if (!force) {
      try {
        const cached = await idbCache.get(CACHE_KEY);
        const cachedAt = await idbCache.get(`cachetime:${CACHE_KEY}`);
        if (cached?.length && Date.now() - Number(cachedAt || 0) < STALKER_CATALOG_TTL_MS) {
          applyItems(cached); fetchingCatRef.current.delete(refKey); return;
        }
      } catch (e) { console.warn("IDB/localStorage error:", e.message); }
    }
    if (!silent) {
      setCatLoading(true);
    }
    try {
      const res  = await fetch(`${API}/stalker/${sec}?${stalkerRequestParams({ cat: catId, ...(force ? { refresh: "1" } : {}) })}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const items = data.items || [];
      applyItems(items);
      // Persist only stable catalog fields; signed playback URLs are stripped.
      idbCache.set(CACHE_KEY, items.map(item => stripTransientStreamFields(transformStalkerItem(item, conn.server))));
      idbCache.set(`cachetime:${CACHE_KEY}`, Date.now());
    } catch(e) { console.error(`Stalker ${sec} cat items:`, e); }
    finally {
      if (!silent) {
        setCatLoading(false);
      }
      fetchingCatRef.current.delete(refKey);
    }
  }

  async function loadNextStalkerPage(sec) {
    if (!STALKER_LAZY_ENABLED || !conn || conn.type !== "stalker") return;
    const kind = sec === "live" ? "live" : sec === "vod" ? "vod" : "series";
    const category = kind === "live"
      ? stalkerLiveCategoryRef.current.id
      : (kind === "vod" ? stalkerVodCats : stalkerSeriesCats).find(item => item.title === cat)?.id;
    const categoryTitle = kind === "live"
      ? stalkerLiveCategoryRef.current.title
      : cat;
    const stateKey = `${kind}:${category || 'all'}`;
    const state = stalkerPageRef.current.get(stateKey);
    if (!state?.hasMore || state.loading) return;
    state.loading = true;
    try {
      const tools = await getStalkerLazyTools();
      const controller = beginStalkerCatalogRequest();
      const request = { kind, category: category || 'all', page: state.nextPage, pageSize: 100, contentToken: contentSessionToken() };
      const data = await tools.api.fetchCatalogPage({ ...request, signal: controller.signal });
      await tools.cache.putPage(data);
      const mapped = data.items.map(item => transformStalkerItem(
        annotateStalkerCatalogItem({ ...item, url: item.playRef }, request, categoryTitle),
        conn.server,
      ));
      const mergeUnique = (prev, additions) => {
        const identity = item => item.id != null && String(item.id) !== ""
          ? `id:${item.id}`
          : `fallback:${item.name || ""}:${item.group || ""}:${item.url || item._stalkerCmd || ""}`;
        const seen = new Set(prev.map(identity));
        return [...prev, ...additions.filter(item => {
          const key = identity(item);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })];
      };
      if (kind === "live") setChannels(prev => mergeUnique(prev, mapped));
      else if (kind === "vod") setVod(prev => mergeUnique(prev, mapped.map(item => ({ ...item, group: cat }))));
      else setSeries(prev => mergeUnique(prev, mapped.map(item => ({ ...item, group: cat }))));
      if (kind === "live") setPage(p => p + 1);
      stalkerPageRef.current.set(stateKey, { ...state, nextPage: data.nextPage, hasMore: data.hasMore, loading: false, total: data.total ?? state.total, totalKnown: data.totalKnown ?? state.totalKnown, complete: data.complete, capabilities: data.capabilities ?? state.capabilities });
    } catch (error) {
      state.loading = false;
      if (error?.name !== "AbortError" && error?.code !== "ABORT_ERR") {
        console.error(`Stalker ${kind} next page failed:`, error);
        if (error?.code === "provider_cooldown" || error?.code === "provider_rate_limited" || error?.status === 429) {
          setConnError(formatStalkerCatalogError(error));
        }
      }
    }
  }

  // ── Option F: background prefetch remaining categories sequentially
  // ── Debounced save: persist vod/series to IDB + D1 when data stabilizes
  async function loadStalkerDiscovery() {
    if (!STALKER_LAZY_ENABLED || conn?.type !== "stalker" || stalkerDiscoveryLoading) return;
    let tools;
    try {
      tools = await getStalkerLazyTools();
    } catch (error) {
      setStalkerDiscoveryError(formatStalkerCatalogError(error, "Provider discovery failed"));
      return;
    }
    if (!tools) return;
    if (stalkerDiscoveryLoadedRef.current === tools.cache.scope) return;
    stalkerDiscoveryLoadedRef.current = tools.cache.scope;
    const controller = new AbortController();
    stalkerDiscoveryRequestRef.current = controller;
    setStalkerDiscoveryLoading(true);
    setStalkerDiscoveryError("");
    setStalkerDiscoveryPartial(false);

    const discovered = [];
    const seen = new Set();
    let partial = false;
    const contentToken = contentSessionToken();
    const addItems = (items, kind, category) => {
      for (const item of items || []) {
        const mapped = transformStalkerItem(annotateStalkerCatalogItem(
          { ...item, url: item.playRef },
          { source: "items", kind, category: category.id, page: 1, pageSize: 100 },
          category.title,
        ), conn.server);
        const key = `${kind}:${mapped.id ?? mapped.name ?? mapped._stalkerCmd ?? ""}`;
        if (!seen.has(key)) {
          seen.add(key);
          discovered.push(mapped);
        }
      }
    };

    try {
      for (const kind of ["vod", "series"]) {
        if (controller.signal.aborted) break;
        let categories = kind === "vod" ? stalkerVodCats : stalkerSeriesCats;
        if (!categories.length) {
          const cached = await tools.cache.getCategories(kind);
          if (cached && !cached.stale) categories = cached.categories || [];
          else {
            const response = await tools.api.fetchCategories({ kind, contentToken, signal: controller.signal });
            await tools.cache.putCategories(kind, response);
            categories = response.categories || [];
          }
        }
        const selected = selectDiscoveryCategories(categories, { seed: discoverySeed(tools.cache.scope), max: 4 });
        for (const category of selected) {
          if (controller.signal.aborted) break;
          const request = { kind, category: String(category.id), page: 1, pageSize: 100, contentToken };
          const cached = await tools.cache.getPage(request);
      const data = cached && !cached.stale
        ? cached
        : await tools.api.fetchCatalogPage({ ...request, signal: controller.signal });
      if (!cached || cached.stale) await tools.cache.putPage(data);
          addItems(data.items, kind, category);
        }
      }
    } catch (error) {
      if (error?.name !== "AbortError" && error?.code !== "ABORT_ERR") {
        partial = true;
        if (error?.code === "provider_cooldown" || error?.code === "provider_rate_limited" || error?.status === 429) {
          setStalkerDiscoveryError(formatStalkerCatalogError(error));
        } else if (error?.status === 401 || error?.status === 403) {
          setStalkerDiscoveryError("The provider temporarily limited discovery. Try again later.");
        } else {
          setStalkerDiscoveryError(formatStalkerCatalogError(error, "Provider discovery failed"));
        }
      }
    } finally {
      if (!controller.signal.aborted) {
        setStalkerDiscoveryItems(discovered.slice(0, 80));
        setStalkerDiscoveryPartial(partial);
        setStalkerDiscoveryLoading(false);
      }
      if (stalkerDiscoveryRequestRef.current === controller) stalkerDiscoveryRequestRef.current = null;
    }
  }

  const contentSaveTimer = useRef(null);
  useEffect(() => {
    if (!conn || (conn.type === "stalker" && STALKER_LAZY_ENABLED)) return;
    const cId = connId(conn);
    if (!cId) return;
    clearTimeout(contentSaveTimer.current);
    contentSaveTimer.current = setTimeout(() => {
      if (vod.length) {
        idbCache.set(`content:${cId}:vod`, conn.type === "stalker" ? vod.map(stripTransientStreamFields) : vod);
        setLastSynced(prev => { const n = { ...prev, vod: Date.now() }; idbCache.set(`sync:${cId}`, n); return n; });
      }
      if (series.length) {
        idbCache.set(`content:${cId}:series`, conn.type === "stalker" ? series.map(stripTransientStreamFields) : series);
        setLastSynced(prev => { const n = { ...prev, series: Date.now() }; idbCache.set(`sync:${cId}`, n); return n; });
      }
    }, 3000);
    return () => clearTimeout(contentSaveTimer.current);
  }, [vod, series, conn]);

  function stalkerPlayUrl(cmd, contentType = "live", episode = null, channelId = null, episodeMeta = {}) {
    const params = new URLSearchParams({
      portal: conn.server,
      mac: conn.mac,
      cmd,
      content_type: contentType,
    });
    if (conn.serial) params.set("serial", conn.serial);
    if (conn.deviceId) params.set("deviceId", conn.deviceId);
    if (conn.deviceId2) params.set("deviceId2", conn.deviceId2);
    if (contentType === "live" && channelId != null) params.set("channel_id", String(channelId));
    if (episodeMeta.episodeId != null) params.set("episode_id", String(episodeMeta.episodeId));
    if (episodeMeta.seasonId != null) params.set("season_id", String(episodeMeta.seasonId));
    if (episodeMeta.seriesNumber != null) params.set("series_number", String(episodeMeta.seriesNumber));
    if (episodeMeta.videoId != null) params.set("video_id", String(episodeMeta.videoId));
    const sessionToken = contentSessionToken();
    if (sessionToken) {
      params.delete("portal");
      params.delete("mac");
      params.set("contentToken", sessionToken);
    }
    let url = `${API}/stalker/play?${params.toString()}`;
    if (episode) url += `&episode=${episode}`;
    return url;
  }

  async function resolveStalkerStream(item, contentType = item.type || "live", options = {}) {
    const controller = options.signal ? null : new AbortController();
    const signal = options.signal || controller.signal;
    if (controller) {
      stalkerResolveRef.current?.abort();
      stalkerResolveRef.current = controller;
    }
    let currentItem = item;
    let retriedExpiredReference = false;
    let forceReferenceRefresh = false;
    const refreshCatalogItem = async ({ forceProvider = false } = {}) => {
      const request = currentItem?._stalkerCatalogRequest;
      if (!request || !STALKER_LAZY_ENABLED) return null;
      const tools = await getStalkerLazyTools();
      const page = request.source === 'search'
        ? await tools.api.searchProvider({
            kind: request.kind,
            category: request.category,
            query: request.query,
            page: request.page,
            pageSize: request.pageSize,
            contentToken: contentSessionToken(),
            signal,
          })
        : await tools.api.fetchCatalogPage({
            kind: request.kind,
            category: request.category,
            page: request.page,
            pageSize: request.pageSize,
            contentToken: contentSessionToken(),
            refresh: forceProvider,
            signal,
          });
      if (request.source !== 'search') await tools.cache.putPage(page);
      let match = findExactCatalogItem(page.items, currentItem);
      if (!match && !forceProvider && request.source !== 'search') {
        return refreshCatalogItem({ forceProvider: true });
      }
      if (!match?.playRef) return null;
      currentItem = {
        ...currentItem,
        ...match,
        url: match.playRef,
        _stalkerCmd: match.playRef,
        _stalkerCatalogRequest: request,
      };
      return currentItem;
    };
    try {
      if (!currentItem._stalkerCmd && await refreshCatalogItem()) {
        retriedExpiredReference = true;
      }
      while (true) {
        const cmd = currentItem._stalkerCmd;
        let fallbackUrl = stalkerPlayUrl(cmd, contentType, options.episode, contentType === "live" ? currentItem.id : null, options.episodeMeta || {});
        if (options.start) fallbackUrl += `&start=${options.start}`;
        if (options.end) fallbackUrl += `&end=${options.end}`;
        if (options.duration) fallbackUrl += `&duration=${options.duration}`;
        if (options.programId != null) fallbackUrl += `&program_id=${encodeURIComponent(options.programId)}`;
        const refreshFlag = options.reason || forceReferenceRefresh ? "&refresh=1" : "";
        const res = await fetch(`${fallbackUrl}&resolve=1${refreshFlag}`, { signal });
        let data = null;
        try { data = await res.json(); } catch { data = null; }
        if (!res.ok) {
          const expired = res.status === 410 || data?.code === "play_ref_expired";
          if (expired && !retriedExpiredReference) {
            if (await refreshCatalogItem()) {
              retriedExpiredReference = true;
              continue;
            }
            // Legacy aggregate catalog responses have no page origin to
            // rehydrate. Ask the backend to rematerialize the same bound
            // command instead of rebuilding the full catalog.
            retriedExpiredReference = true;
            forceReferenceRefresh = true;
            continue;
          }
          throw Object.assign(new Error(data?.error || `Stream resolution returned ${res.status}`), { code: data?.code, status: res.status });
        }
      if (!data.url) throw new Error("Portal did not return a stream URL");
      const directUrl = data.url;
      const direct = data.direct !== false;
      const streamKind = data.streamKind || classifyStreamUrl(directUrl, contentType);
      if (!direct || !directUrl) {
        const error = new Error(data.error || "The provider did not return a browser-playable direct URL");
        error.code = data.code || "direct_play_unavailable";
        error.relayAvailable = data.relayAvailable === true;
        throw error;
      }
      return {
        url: directUrl,
        streamKind,
        directUrl,
        expiresAt: data.expiresAt ?? null,
        _direct: true,
        _stalkerDirectOnly: data.relayAvailable !== true,
        _stalkerRelayAvailable: data.relayAvailable === true,
        _stalkerRelayUrl: data.relayAvailable === true ? data.relayUrl : null,
        _stalkerRefreshUrl: data.refreshUrl || `${fallbackUrl}&resolve=1`,
        directCapability: data.directCapability || "browser_candidate",
        streamGeneration: data.generation || null,
        streamWarnings: Array.isArray(data.warnings) ? data.warnings : [],
      };
      }
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      console.warn("Stalker direct-play resolution failed", error);
      throw error;
    } finally {
      if (controller && stalkerResolveRef.current === controller) stalkerResolveRef.current = null;
    }
  }

  async function refreshStalkerStream(item, reason = "refresh") {
    if (conn?.type !== "stalker" || !item?._stalkerCmd) return null;
    const refreshed = await resolveStalkerStream(item, item.type || "live", { reason });
    if (!refreshed?.url) return null;
    return { ...item, ...refreshed };
  }

  async function requestStalkerRelay(item) {
    if (!item?._stalkerRelayAvailable || !item?._stalkerRelayUrl) return null;
    const relayUrl = new URL(item._stalkerRelayUrl, location.origin);
    const contentToken = relayUrl.searchParams.get("contentToken");
    const cmd = relayUrl.searchParams.get("cmd");
    if (!contentToken || !cmd) throw new Error("Compatibility relay control data is unavailable");
    const grantResponse = await fetch(`${API}/stalker/relay-grant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentToken, cmd, confirm: true }),
    });
    const grant = await grantResponse.json();
    if (!grantResponse.ok || !grant.relayGrant) throw new Error(grant.error || "Compatibility relay was not authorized");
    relayUrl.searchParams.set("relayGrant", grant.relayGrant);
    return { ...item, url: relayUrl.pathname + relayUrl.search, _direct: false, _stalkerRelayActive: true };
  }

  async function loadEPG(url, label) {
    if (!url) return;
    const token = epgLoadToken.current;
    setEpgLoading(true);
    try {
      const res = await proxyFetch(url);
      const text = await res.text();
      if (token !== epgLoadToken.current) return; // Stale load, ignore
      const data = parseXMLTV(text);
      const id = url;
      const newSource = { id, label: label || new URL(url).hostname, kind: "xmltv", sourceKey: id, connectionId: activeConnId, data };
      setEpgSources(prev => {
        if (token !== epgLoadToken.current) return prev; // Stale, don't update
        const idx = prev.findIndex(s => s.id === id);
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = newSource;
          return copy;
        }
        return [...prev, newSource];
      });
      setEpgURL(url);
      if (!httpContentMode) {
        db.set("sv-epgURL", url);
      }
    } catch(e) { if (token === epgLoadToken.current) console.error("EPG error:", e); }
    finally { if (token === epgLoadToken.current) setEpgLoading(false); }
  }

  // ── load EPG when connection is active
  useEffect(() => {
    if (conn?.type === "stalker") loadStalkerEPG();
  }, [activeConnId]);

  async function loadStalkerEPG() {
    if (!conn || conn.type !== "stalker") return;
    const token = epgLoadToken.current;
    setEpgLoading(true);
    try {
      const params = stalkerRequestParams({ period: 24 });

      const res = await fetch(`${API}/stalker/epg?${params}`);
      const data = await safeJsonFetch(res);
      if (token !== epgLoadToken.current) return; // Stale, ignore
      if (data.programs) {
        const id = `stalker:${conn.server}:${conn.mac}`;
        const label = `Stalker · ${conn.mac.slice(-5)}`;
        const newSource = { id, label, kind: "stalker", sourceKey: id, connectionId: activeConnId, data: data.programs };
        setEpgSources(prev => {
          if (token !== epgLoadToken.current) return prev; // Stale, don't update
          const idx = prev.findIndex(s => s.id === id);
          if (idx >= 0) {
            const copy = [...prev];
            copy[idx] = newSource;
            return copy;
          }
          return [...prev, newSource];
        });
      }
    } catch(e) { if (token === epgLoadToken.current) console.error("Stalker EPG error:", e); }
    finally { if (token === epgLoadToken.current) setEpgLoading(false); }
  }

  function switchSection(s) {
    setSection(s); setSearch(""); setPage(1); setExpandedItem(null);
    localStorage.setItem("sv-lastSection", JSON.stringify(s));
    if (s === "vod") {
      if (conn?.type === "stalker") { setCat(null); loadStalkerCats("vod"); }
      else { setCat("All"); fetchVOD(); }
    } else if (s === "series") {
      if (conn?.type === "stalker") { setCat(null); loadStalkerCats("series"); }
      else { setCat("All"); fetchSeries(); }
    } else if (s === "live" && conn?.type === "stalker" && STALKER_LAZY_ENABLED) {
      setCat(stalkerLiveCategoryRef.current.title || "All");
    } else {
      setCat("All");
    }
  }

  // ── favorites
  function toggleFav(item) {
    const type = item.type || "live";
    const newFavs = { ...favs, [type]: { ...favs[type] } };
    const key = item.id || item.url;
    if (newFavs[type][key]) delete newFavs[type][key];
    else {
      const stableItem = stripTransientStreamFields(item);
      newFavs[type][key] = { id:stableItem.id, name:stableItem.name, url:stableItem.url, logo:stableItem.logo, group:stableItem.group, type, _stalkerCmd:stableItem._stalkerCmd };
      track("favorite");
    }
    setFavs(newFavs);
    if (activeConnId) {
      db.set(`sv-favs-${activeConnId}`, newFavs);
      if (activeConnId) syncToServer("favorites", activeConnId, newFavs);
    }
  }

  function isFav(item) {
    const type = item?.type || "live";
    return !!(item && favs[type]?.[item.id || item.url]);
  }

  // ── history / continue watching
  function persistHistory(newHistory, flush = false) {
    historyRef.current = newHistory;
    setHistory(newHistory);
    if (!activeConnId) return;
    const now = Date.now();
    if (flush || !lastHistoryLocalWriteRef.current || now - lastHistoryLocalWriteRef.current >= 20000) {
      lastHistoryLocalWriteRef.current = now;
      db.set(`sv-history-${activeConnId}`, newHistory);
    }
    if (flush || !lastHistoryServerSyncRef.current || now - lastHistoryServerSyncRef.current >= 60000) {
      lastHistoryServerSyncRef.current = now;
      syncToServer("history", activeConnId, newHistory);
    }
  }

  function historyKey(item) {
    return item?.id || item?.url;
  }

  function withResumePosition(item) {
    const key = historyKey(item);
    if (!key || item?.type === "live") return item;
    const previous = historyRef.current.find(h => historyKey(h) === key);
    if (!previous?.position || previous.position <= 5) return item;
    return { ...item, position: previous.position, duration: previous.duration || item.duration };
  }

  function addHistory(item) {
    const stableItem = stripTransientStreamFields(item);
    const previous = historyRef.current.find(h => historyKey(h) === historyKey(stableItem));
    const entry = {
      ...stableItem,
      timestamp: Date.now(),
      position: stableItem.type === "live" ? 0 : Number(previous?.position || stableItem.position || 0),
      duration: Number(previous?.duration || stableItem.duration || 0),
    };
    persistHistory([entry, ...historyRef.current.filter(h => historyKey(h) !== historyKey(stableItem))].slice(0, 60), true);
  }

  function updateHistoryProgress(item, { position = 0, duration = 0, completed = false, reason = 'interval' } = {}) {
    if (!item || item.type === "live") return;
    const key = historyKey(item);
    if (!key) return;
    const nearEnd = duration > 0 && duration - position < 30;
    const next = historyRef.current.map(h => {
      if (historyKey(h) !== key) return h;
      return {
        ...h,
        timestamp: Date.now(),
        position: completed || nearEnd ? 0 : Math.max(0, position),
        duration: duration || h.duration || item.duration || 0,
      };
    });
    const flush = reason === 'ended' || reason === 'close' || reason === 'pause' || reason === 'hidden';
    persistHistory(next, flush);
  }

  async function playItem(item) {
    item = withResumePosition(item);
    // If this is a series item, open the detail modal instead of playing
    if (item.type === "series") {
      openSeriesDetail(item);
      return;
    }

  trackAnalytics("play_item", {
    content_type: item.type || "live",
    provider_type: conn?.type || "unknown",
    category_scope: cat === "All" ? "all" : "filtered",
    is_favorite: isFav(item)
  });
    
    track("play", { name: item.name, type: item.type || "live" });
    track("history");
    if (conn?.type === "stalker" && (item._stalkerCmd || item._stalkerCatalogRequest)) {
      try {
        const resolved = await runPlaybackResolve({
          name: item.name || "Selected content",
          operation: ({ signal }) => resolveStalkerStream(item, item.type || "live", { signal }),
        });
        if (!resolved?.url) {
          return;
        }
        const resolved_item = { ...item, ...resolved };
        setPlaying(resolved_item);
        addHistory(resolved_item);
      } catch (error) {
        if (isPlaybackResolveCancellation(error)) return;
        if (error?.code === "playback_resolve_timeout") {
          setConnError(`${error.message} Try again later.`);
          return;
        }
        console.error("Stalker direct playback unavailable:", error);
        setConnError(error?.message || "The provider did not return a direct browser-playable stream");
      }
    } else if (shouldUseTokenPlayerForItem(conn, item, window.location)) {
      // Xtream and M3U streams play via token-gated redirect to HTTP player
      const streamUrl = item.url;
      if (!streamUrl) return;
      try {
        const res = await fetch("/api/play-token", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ url: streamUrl }),
        });
        if (res.ok) {
          const data = await res.json();
          window.location.href = data.playerUrl;
          return;
        }
      } catch (e) {
        console.warn("Play token failed, falling back to direct play", e);
      }
      // Fallback: play directly in-page
      const directItem = { ...item, _direct: true };
      setPlaying(directItem);
      addHistory(directItem);
    } else if (conn?.type === "xtream" || conn?.type === "m3u") {
      const directItem = { ...item, _direct: true };
      setPlaying(directItem);
      addHistory(directItem);
    } else {
      setPlaying(item);
      addHistory(item);
    }
  }

  // ── catchup / timeshift playback for past EPG programs
  async function playCatchup(channel, program) {
    if (!program || !channel) return;
    const startUTC = Math.floor(program.start / 1000);
    const endUTC = Math.floor(program.stop / 1000);
    const durationMin = Math.round((program.stop - program.start) / 60000);
    const catchupItem = {
      ...channel,
      name: `${channel.name} - ${program.title}`,
      _catchupProgram: program.title,
      type: "vod", // treat catchup as VOD for seeking support
    };

    trackAnalytics("play_item", {
      content_type: "catchup",
      provider_type: conn?.type || "unknown",
      category_scope: cat === "All" ? "all" : "filtered",
      is_favorite: isFav(channel)
    });

    track("play", { name: catchupItem.name, type: "catchup" });
    track("history");

    try {
      if (conn?.type === "stalker" && channel._stalkerCmd) {
        const resolved = await runPlaybackResolve({
          name: catchupItem.name,
          operation: ({ signal }) => resolveStalkerStream(
            { id: channel.id, _stalkerCmd: program.cmd || channel._stalkerCmd, type: "live" },
            "live",
            { signal, start: startUTC, end: endUTC, duration: Math.max(1, endUTC - startUTC), programId: program.id || program.programId },
          ),
        });
        Object.assign(catchupItem, resolved);
      } else if (conn?.type === "xtream" && channel.url) {
        // Xtream Codes: try timeshift URL formats
        const streamId = channel.id;
        const base = conn.server;
        // Format 1: /timeshift/{user}/{pass}/{duration}/{start}/{stream_id}.ts
        const startFmt = new Date(program.start).toISOString().replace(/[-:T]/g, "").slice(0, 14); // YYYYMMDDHHmmss
        const tsUrl = `${base}/timeshift/${conn.user}/${conn.pass}/${durationMin}/${startFmt}/${streamId}.ts`;
        catchupItem.url = tsUrl;
        catchupItem._direct = true;
      } else if (channel.url) {
        // M3U / generic: try appending ?utc=&lutc= params
        const sep = channel.url.includes("?") ? "&" : "?";
        catchupItem.url = `${channel.url}${sep}utc=${startUTC}&lutc=${endUTC}`;
      }
    } catch (e) {
      if (isPlaybackResolveCancellation(e)) return;
      if (e?.code === "playback_resolve_timeout") {
        setConnError(`${e.message} Try again later.`);
        return;
      }
      console.error("Catchup URL construction failed:", e);
    }

    // Fall back to normal live playback if no catchup URL resolved
    if (!catchupItem.url) {
      console.warn("Catchup not available, falling back to live stream");
      playItem(channel);
      return;
    }

    setPlaying(catchupItem);
    addHistory(catchupItem);
  }

  // ── series detail (seasons/episodes)
  async function openSeriesDetail(item) {
    if (!item || item.type !== "series") return;
    setSeriesLoading(true);
    setSeriesDetail({ item, seasons: [], activeSeason: 0 });

    try {
      if (conn?.type === "stalker") {
        const res = await fetch(`${API}/stalker/series/seasons?${stalkerRequestParams({ seriesId: item.id })}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        const seasons = data.seasons || [];
        setSeriesDetail({ item, seasons, activeSeason: 0 });
      } else if (conn?.type === "xtream") {
        const api = makeXtreamAPI(conn.server, conn.user, conn.pass);
        const info = await api.getSeriesInfo(item.id);
        const seasonNums = Object.keys(info.episodes || {}).sort((a,b) => Number(a) - Number(b));
        const seasons = seasonNums.map(sn => ({
          id: `${item.id}:${sn}`,
          name: `Season ${sn}`,
          episodes: (info.episodes[sn] || []).map(ep => ({
            num: ep.episode_num,
            title: ep.title || `Episode ${ep.episode_num}`,
            id: ep.id,
            ext: ep.container_extension || "mp4",
          })),
        }));
        setSeriesDetail({ item, seasons, activeSeason: 0, xtreamInfo: info });
      }
    } catch(e) {
      console.error("Series detail error:", e);
      setSeriesDetail(null);
    } finally {
      setSeriesLoading(false);
    }
  }

  async function playSeriesEpisode(season, episodeNum) {
    if (!seriesDetail) return;
    setEpisodeLoading(episodeNum);
    try {
      if (conn?.type === "stalker") {
        const episode = season.episodes?.find(ep => ep.num == episodeNum || ep.id == episodeNum) || {};
        const resolved = await runPlaybackResolve({
          name: `${seriesDetail.item.name} - ${season.name} E${episodeNum}`,
          operation: ({ signal }) => resolveStalkerStream(
            { _stalkerCmd: episode.cmd || season.cmd, type: "series" },
            "series",
            {
              signal,
              episode: episode.num ?? episodeNum,
              episodeMeta: {
                episodeId: episode.id,
                seasonId: season.id,
                seriesNumber: episode.series_number ?? episode.seriesNumber ?? episode.num ?? episodeNum,
                videoId: episode.video_id ?? episode.videoId,
              },
            },
          ),
        });
        const epItem = {
          id: `${seriesDetail.item.id}-s${seriesDetail.activeSeason}-e${episodeNum}`,
          name: `${seriesDetail.item.name} - ${season.name} E${episodeNum}`,
          ...resolved,
          logo: seriesDetail.item.logo,
          type: "vod",
          group: seriesDetail.item.group,
        };
        setPlaying(epItem);
        addHistory(epItem);
      } else if (conn?.type === "xtream") {
        const ep = season.episodes?.find(e => e.num == episodeNum || e.id == episodeNum);
        if (!ep) return;
        const api = makeXtreamAPI(conn.server, conn.user, conn.pass);
        const streamUrl = api.seriesStreamURL(ep.id, ep.ext || "mp4");
        const epItem = {
          id: `${seriesDetail.item.id}-e${ep.id}`,
          name: `${seriesDetail.item.name} - ${season.name} ${ep.title || `E${ep.num}`}`,
          url: streamUrl,
          logo: seriesDetail.item.logo,
          type: "vod",
          group: seriesDetail.item.group,
        };
        setPlaying(epItem);
        addHistory(epItem);
      }
    } catch(e) {
      if (isPlaybackResolveCancellation(e)) return;
      if (e?.code === "playback_resolve_timeout") {
        setConnError(`${e.message} Try again later.`);
        return;
      }
      console.error("Episode play error:", e);
    } finally {
      setEpisodeLoading(null);
    }
  }

  // ── connection management
  function makeConnectionLabel(type, config) {
    if (type === "xtream") return `${config.user} · Xtream`;
    if (type === "stalker") { try { const host = new URL(config.server).hostname.replace(/^(www|portal)\./, ""); return `${host} · ${(config.mac||"").slice(-8)}`; } catch (e) { console.warn("IDB/localStorage error:", e.message); } return `Stalker · ${(config.mac||"").slice(-8)}`; }
    if (type === "m3u") return `M3U · ${(config.url||"").split("/").pop()?.slice(0,20)||"playlist"}`;
    return "Direct HLS";
  }

  function saveConnection(connConfig) {
    const cId = connId(connConfig);
    if (!cId) return "Invalid connection";
    const existing = connections.find(c => c.id === cId);
    if (existing) {
      // Already saved. Activation is decided by handleConnect after it knows
      // whether this flow will leave the secure app for direct content mode.
      return null;
    }
    // Enforce connection limit
    const maxConns = userLimits?.maxConnections ?? 5;
    if (connections.length >= maxConns) {
      return `Connection limit reached (${maxConns}). Remove a connection to add a new one.`;
    }
    const usedColors = new Set(connections.map(c => c.color));
    const color = PROFILE_COLORS.find(c => !usedColors.has(c)) || PROFILE_COLORS[connections.length % PROFILE_COLORS.length];
    const connObj = { id: cId, type: connConfig.type, label: makeConnectionLabel(connConfig.type, connConfig), color, config: connConfig };
    const newConns = [...connections, connObj];
    setConnections(newConns);
    return null;
  }

  async function switchConnection(id) {
    if (contentSessionOpening) return;
    if (id === activeConnId) { setShowConnManager(false); return; }
    const target = connections.find(c => c.id === id);
    const lifecycleFailure = lifecycleFailureMessage(target);
    if (lifecycleFailure) {
      setConnError(lifecycleFailure);
      setShowConnManager(true);
      return;
    }
    if (!target) return;
    cancelPlaybackResolve();
    abortStalkerCatalogRequests();
    if (!httpContentMode) {
      setContentSessionOpening(true);
      setConnError("");
      try {
        const opened = await maybeOpenDirectContentSession(target, { location: window.location });
        if (opened) return;
      } catch (e) {
        const code = e?.code || e?.status;
        if (code === 401 || code === 403 || /unauthorized|invalid/i.test(e?.message || "")) {
          const homeUrl = getAppHomeUrl();
          if (homeUrl && typeof window !== "undefined" && window.location) {
            window.location.assign(homeUrl + "?reason=auth");
          }
          return;
        }
        setConnError(e?.message || "Failed to open direct content session");
        return;
      } finally {
        setContentSessionOpening(false);
      }
    }
    setShowConnManager(false);
    epgLoadToken.current++; // Invalidate any in-flight EPG loads
    // Clear current content
    setChannels([]); setVod([]); setSeries([]);
    setActiveEpgSource("all");
    setStalkerLiveCats([]);
    setStalkerVodCats([]); setStalkerSeriesCats([]);
    stalkerLiveCategoryRef.current = { id: "all", title: "All" };

    fetchingCatRef.current.clear();
    setPlaying(null); setCat("All");
    // Set conn to new config FIRST so useEffect [activeConnId] sees correct conn
    setConn(target.config);
    setActiveConnId(id);
    (async () => {
      const loaded = await loadFromCache(id, target);
      if (!loaded) setConn(target.config); // fallback if not cached
    })();
  }

  function removeConnection(id) {
    const removedConnection = connections.find(connection => connection.id === id);
    if (removedConnection?.type === "stalker" || removedConnection?.config?.type === "stalker") {
      const ownerId = authUser?.id ? `user:${authUser.id}` : `guest:${GUEST_ID}`;
      const config = removedConnection.config || removedConnection;
      void createStalkerCatalogCache({ ownerId, connection: config })
        .then(cache => cache.clearConnection(config))
        .catch(() => {});
    }
    if (id === activeConnId) abortStalkerCatalogRequests();
    const newConns = connections.filter(c => c.id !== id);
    setConnections(newConns);
    // Clean up localStorage
    localStorage.removeItem(`sv-favs-${id}`);
    localStorage.removeItem(`sv-history-${id}`);
    // Clean up IDB cache (content, categories, sync meta)
    for (const key of [`content:${id}:live`, `content:${id}:vod`, `content:${id}:series`,
      `cats:${id}:vod`, `cats:${id}:series`, `sync:${id}`]) {
      idbCache.set(key, null);
    }
    // Clean up IDB category items (catitems:{connId}:{section}:{catId})
    if (typeof indexedDB !== "undefined") {
      idbCache.get(`cats:${id}:vod`).then(vodCats => {
        (vodCats || []).forEach(c => idbCache.set(`catitems:${id}:vod:${c.id}`, null));
      }).catch(() => {});
      idbCache.get(`cats:${id}:series`).then(seriesCats => {
        (seriesCats || []).forEach(c => idbCache.set(`catitems:${id}:series:${c.id}`, null));
      }).catch(() => {});
    }
    // Clean up server-side sync + cache data
    authFetch(`${API}/api/sync?connId=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
    authFetch(`${API}/api/cache?connId=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
  }

  function addNewConnection() {
    setShowConnManager(false);
    disconnect();
  }

  // ── hidden cats
  function toggleHideCat(sec, catName) {
    const arr = hiddenCats[sec] || [];
    const newArr = arr.includes(catName) ? arr.filter(c=>c!==catName) : [...arr, catName];
    const newHc = { ...hiddenCats, [sec]: newArr };
    setHiddenCats(newHc);
    db.set("sv-hiddenCats", newHc);
  }

  function isCatHidden(sec, catName) {
    return (hiddenCats[sec]||[]).includes(catName);
  }

  // ── context menu close
  useEffect(() => {
    const close = () => setCtx(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  useEffect(() => { setPage(1); }, [cat, search, section]);

  function handleEditConnection(updatedConn) {
    // Update connections array
    const newConns = connections.map(c =>
      c.id === updatedConn.id ? updatedConn : c
    );
    setConnections(newConns);

    // If this is the active connection, update the current conn
    if (activeConnId === updatedConn.id) {
      setConn(updatedConn.config);
    }

    // Only reload if we have a valid connection config
    if (updatedConn.type === "stalker" && updatedConn.config?.server && updatedConn.config?.mac) {
      setChannels([]);
      setVod([]);
      setSeries([]);
      setStalkerLiveCats([]);
      setStalkerVodCats([]);
      setStalkerSeriesCats([]);
      stalkerLiveCategoryRef.current = { id: "all", title: "All" };
      fetchingCatRef.current.clear();
      setCat(null);

      // Reload Live TV
      fetchStalkerChannels(true);

      // Reload Movies
      loadStalkerCats("vod", true);

      // Reload Series
      loadStalkerCats("series", true);
    } else if (updatedConn.type === "xtream" && updatedConn.config?.server && updatedConn.config?.user) {
      // For Xtream, just clear data without reloading since the API will handle it
      setVod([]);
      setSeries([]);
      setStalkerLiveCats([]);
      setStalkerVodCats([]);
      setStalkerSeriesCats([]);
      stalkerLiveCategoryRef.current = { id: "all", title: "All" };
      fetchingCatRef.current.clear();
      setCat(null);
    } else if (updatedConn.type === "m3u" && updatedConn.config?.url) {
      // For M3U, just clear data without reloading
      setVod([]);
      setSeries([]);
      setStalkerLiveCats([]);
      setStalkerVodCats([]);
      setStalkerSeriesCats([]);
      stalkerLiveCategoryRef.current = { id: "all", title: "All" };
      fetchingCatRef.current.clear();
      setCat(null);
    }
  }

  function disconnect() {
    cancelPlaybackResolve();
    if (httpContentMode) {
      clearContentSessionToken();
      setEphemeralConnection(null);
      setContentSessionError("");
      navigateToAppHome({ location: window.location });
      return;
    }
    abortStalkerCatalogRequests();
    setConn(null); setChannels([]); setVod([]); setSeries([]);
    setStalkerLiveCats([]);
    setStalkerVodCats([]); setStalkerSeriesCats([]);
    stalkerLiveCategoryRef.current = { id: "all", title: "All" };

    fetchingCatRef.current.clear();
    setSection("live"); setPlaying(null); setCat("All");
    setActiveConnId(null);
    db.set("sv-activeConn", null);
  }

  // ── DERIVED DATA
  const getItems = useCallback((sec) => sec==="live"?channels : sec==="vod"?vod : series, [channels, vod, series]);

  const curCatsAll = useMemo(() => {
    if (section === "favorites") return ["All"];
    if (conn?.type === "stalker" && (section === "live" || section === "vod" || section === "series")) {
      const apiCats = section === "live" ? stalkerLiveCats : section === "vod" ? stalkerVodCats : stalkerSeriesCats;
      if (apiCats.length) return apiCats.map(c => c.title);
    }
    const items = getItems(section) || [];
    return ["All", ...new Set(items.map(i=>i.group).filter(Boolean))];
  }, [conn, section, stalkerLiveCats, stalkerVodCats, stalkerSeriesCats, getItems]);

  const curItemsAll = useMemo(() => {
    if (!cat || section === "favorites") return [];
    const items = getItems(section) || [];
    return items.filter(item => {
      let catMatch = false;
      if (cat === "All") {
        catMatch = !isCatHidden(section, item.group);
      } else {
        catMatch = item.group === cat;
      }
      const searchMatch = !deferredSearch || item.name?.toLowerCase().includes(deferredSearch.toLowerCase());
      return catMatch && searchMatch;
    });
  }, [cat, getItems, deferredSearch, section, hiddenCats, isCatHidden]);

  const favItems = useMemo(() => ({
    live: Object.values(favs.live||{}),
    vod:  Object.values(favs.vod||{}),
    series: Object.values(favs.series||{}),
  }), [favs]);
  const totalFavs = favItems.live.length + favItems.vod.length + favItems.series.length;

  const continueItems = useMemo(() =>
    history.filter(h => h.position > 5 && h.type !== "live").slice(0, 20),
  [history]);

  const historyMap = useMemo(() => {
    const m = new Map();
    for (const h of history) m.set(h.id || h.url, h);
    return m;
  }, [history]);

  // ── Smart recommendations: genre-based matching from watch history + favorites
  const recommendations = useMemo(() => {
    if (section !== "vod" && section !== "series") return [];
    const items = section === "vod" ? vod : series;
    if (items.length === 0) return [];
    // Collect genres from history + favorites
    const watchedIds = new Set();
    const genreCount = {};
    const sources = [...history.filter(h => h.type === section).slice(0, 20), ...Object.values(favs[section] || {})];
    for (const h of sources) {
      watchedIds.add(h.id || h.url);
      const genre = h.group || h.genre;
      if (genre && genre !== "All" && genre !== "Other" && genre !== "Uncategorized") {
        genreCount[genre] = (genreCount[genre] || 0) + 1;
      }
    }
    if (Object.keys(genreCount).length === 0) return [];
    // Rank genres by frequency
    const topGenres = Object.entries(genreCount).sort((a, b) => b[1] - a[1]).slice(0, 5).map(g => g[0]);
    // Find items in top genres that user hasn't watched, randomize & limit
    const candidates = items.filter(item => {
      if (watchedIds.has(item.id || item.url)) return false;
      return topGenres.includes(item.group);
    });
    // Shuffle and pick 20
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    return candidates.slice(0, 20);
  }, [section, vod, series, history, favs]);

  const [providerSearchResults, setProviderSearchResults] = useState([]);
  const [cachedStalkerSearchResults, setCachedStalkerSearchResults] = useState([]);
  useEffect(() => {
    if (!STALKER_LAZY_ENABLED || conn?.type !== "stalker" || deferredGlobalQ.trim().length < 2) {
      setProviderSearchResults([]);
      setCachedStalkerSearchResults([]);
      return undefined;
    }
    const controller = new AbortController();
    const query = deferredGlobalQ.trim();
    setProviderSearchResults([]);
    const run = async () => {
      try {
        const tools = await getStalkerLazyTools();
        const cached = await tools.cache.searchPages(query);
        if (!controller.signal.aborted) setCachedStalkerSearchResults(cached);
        const results = [];
        let stopAfterFailure = false;
        for (const kind of ["live", "vod", "series"]) {
          if (controller.signal.aborted || stopAfterFailure) return;
          const supportsProviderSearch = [...stalkerPageRef.current.entries()]
            .filter(([key]) => key.startsWith(`${kind}:`))
            .some(([, state]) => state?.capabilities?.search === "supported");
          if (!supportsProviderSearch) continue;
          try {
            const data = await tools.api.searchProvider({ kind, query, page: 1, pageSize: 80, contentToken: contentSessionToken(), signal: controller.signal });
            results.push(...(data.items || []).map(item => transformStalkerItem(annotateStalkerCatalogItem({ ...item, url: item.playRef }, { source: 'search', kind, category: 'all', query, page: 1, pageSize: 80 }), conn.server)));
          } catch (error) {
            if (error?.code === "provider_cooldown" || error?.code === "provider_rate_limited" || error?.status === 429 || error?.status === 401 || error?.status === 403) {
              stopAfterFailure = true;
              if (error?.code === "provider_cooldown" || error?.code === "provider_rate_limited" || error?.status === 429) {
                setConnError(formatStalkerCatalogError(error));
              }
              break;
            }
            if (error?.code !== "provider_search_unsupported") console.warn("Stalker provider search failed:", error.message);
          }
        }
        if (!controller.signal.aborted) setProviderSearchResults(results);
      } catch (error) {
        if (!controller.signal.aborted) console.warn("Stalker provider search setup failed:", error.message);
      }
    };
    const timer = setTimeout(run, 400);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [conn, deferredGlobalQ, getStalkerLazyTools]);

  // ── global search
  const searchResults = useMemo(() => {
    if (deferredGlobalQ.length <= 1) return [];
    const q = deferredGlobalQ.toLowerCase();
    const matches = (item) => {
      const haystack = [item?.name, item?.group, item?.genre, item?.plot, item?.description].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(q);
    };
    const local = [...cachedStalkerSearchResults, ...channels, ...vod, ...series].filter(matches);
    const provider = providerSearchResults.filter(matches);
    const seen = new Set();
    return [...local, ...provider].filter(item => {
      const key = `${item.type}:${item.id || item.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 80);
  }, [deferredGlobalQ, channels, vod, series, cachedStalkerSearchResults, providerSearchResults]);

  const stalkerSearchLimited = STALKER_LAZY_ENABLED && conn?.type === "stalker"
    && ![...stalkerPageRef.current.values()].some(state => state?.capabilities?.search === "supported");

  const onAllowedPage = (authUser || isGuest) && !!conn;
  const LABEL = {discover:t("discover"),live:t("live"),vod:t("movies"),series:t("series"),favs:t("favorites"),continue:t("continueWatching"),epg:t("tvGuide"),search:t("globalSearch"),hls:t("directPlay"),settings:t("settings")};
  const activeConnection = httpContentMode
    ? ephemeralConnection
    : connections.find(c => c.id === activeConnId);

  function leaveContentForConnectionChange() {
    if (!httpContentMode) {
      setShowConnManager(true);
      return;
    }

    const shouldLeave = window.confirm(
      "This player session is tied to the current connection. Return to secure setup to choose another connection?"
    );
    if (!shouldLeave) return;

    clearContentSessionToken();
    navigateToAppHome({ location: window.location });
  }

  const channelCount = channels.length + vod.length + series.length;
  const curCats = ["live","vod","series"].includes(section) ? curCatsAll : [];
  const curItems = ["live","vod","series"].includes(section) ? curItemsAll : [];
  const lazyStateKey = `${section}:${section === "live"
    ? stalkerLiveCategoryRef.current.id
    : ((section === "vod" ? stalkerVodCats : stalkerSeriesCats).find(item => item.title === cat)?.id || "all")}`;
  const lazyState = STALKER_LAZY_ENABLED && conn?.type === "stalker" ? stalkerPageRef.current.get(lazyStateKey) : null;
  const lazyHasMore = Boolean(lazyState?.hasMore);
  const hasMore = lazyHasMore || page * PAGE_SIZE < curItems.length;
  const paginatedItems = curItems.slice(0, page * PAGE_SIZE);

  const contentScrollRef = useRef(null);
  const hasUserScrolledContentRef = useRef(false);
  const autoLoadBurstRef = useRef(0);
  const autoLoadCooldownRef = useRef(0);
  const autoLoadThresholdPx = 500;
  const autoLoadCooldownMs = 350;
  const autoLoadBurstLimit = 3;

  // Reset scroll position when section or category changes
  useLayoutEffect(() => {
    hasUserScrolledContentRef.current = false;
    autoLoadBurstRef.current = 0;
    autoLoadCooldownRef.current = 0;
    if (contentScrollRef.current) {
      contentScrollRef.current.scrollTop = 0;
    }
  }, [section, cat, search]);

  const handleContentScroll = useCallback((e) => {
    const el = e.currentTarget;
    if (el.scrollTop > 0) hasUserScrolledContentRef.current = true;

    if (!autoLoadMore || !hasMore || !["live","vod","series"].includes(section) || !hasUserScrolledContentRef.current) return;

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom > autoLoadThresholdPx * 2) {
      autoLoadBurstRef.current = 0;
      return;
    }
    if (distanceFromBottom > autoLoadThresholdPx) return;
    if (autoLoadBurstRef.current >= autoLoadBurstLimit) return;
    const now = Date.now();
    if (now - autoLoadCooldownRef.current < autoLoadCooldownMs) return;

    autoLoadBurstRef.current += 1;
    autoLoadCooldownRef.current = now;
    setPage(p => p + 1);
  }, [autoLoadMore, hasMore, section]);

  useEffect(() => {
    if (!autoLoadMore || !hasMore || !["live","vod","series"].includes(section) || !contentScrollRef.current) return;
    const el = contentScrollRef.current;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom > autoLoadThresholdPx) return;
    if (!hasUserScrolledContentRef.current) return;
    if (autoLoadBurstRef.current >= autoLoadBurstLimit) return;
    const now = Date.now();
    if (now - autoLoadCooldownRef.current < autoLoadCooldownMs) return;

    const timer = setTimeout(() => {
      autoLoadBurstRef.current += 1;
      autoLoadCooldownRef.current = Date.now();
      setPage(p => p + 1);
    }, 80);
    return () => clearTimeout(timer);
  }, [page, autoLoadMore, hasMore, section]);

  async function handleConnect(connConfig) {
    const startTime = Date.now();
    const err = saveConnection(connConfig);
    
    trackAnalytics("portal_connect", {
      provider_type: connConfig.type,
      auth_type: connConfig.authType || "direct",
      success: err ? "false" : "true",
      latency_ms: Date.now() - startTime,
      error_code: err ? String(err).slice(0, 50) : null
    });

    if (err) { alert(err); return; }

    // Open direct content immediately after setup. Otherwise the first playback
    // click still runs on the secure page and falls back to the legacy player.
    const id = connId(connConfig);
    const saved = connections.find(c => c.id === id);
    const target = saved || {
      id,
      type: connConfig.type,
      label: makeConnectionLabel(connConfig.type, connConfig),
      config: connConfig,
    };

    if (!httpContentMode) {
      setContentSessionOpening(true);
      setConnError("");
      try {
        const opened = await maybeOpenDirectContentSession(target, { location: window.location });
        if (opened) return;
      } catch (e) {
        setConnError(e?.message || "Failed to open direct content session");
        return;
      } finally {
        setContentSessionOpening(false);
      }
    }

    // Only persist an active connection when this flow stays on the secure
    // app. Direct content sessions use an ephemeral active connection on the
    // HTTP origin and must not auto-reopen when disconnect returns to /app.
    setActiveConnId(id);
    setConn(connConfig);
  }

  async function processFullImport(data) {
    if (!data._portal_heaven_export) throw new Error("Not a valid Portal Heaven export file");

    let favCount = 0, histCount = 0;
    const parts = [];

    // 1. Import connections
    if (data.connections?.length) {
      const storedConnections = await db.get("sv-connections", []);
      const existing = mergeConnectionSnapshots(storedConnections, connections);
      const maxConnections = userLimits?.maxConnections ?? 5;
      const result = mergeConnectionsWithinLimit(existing, data.connections, maxConnections);
      if (result.added.length || result.connections.length !== storedConnections.length) setConnections(result.connections);
      parts.push(`${result.added.length} new of ${data.connections.length} connections`);
      if (result.skipped) parts.push(`${result.skipped} skipped (account limit: ${maxConnections})`);
    }

    // 2. Import preferences
    if (data.theme) { 
      db.set("sv-theme", data.theme); 
      setThemeName(data.theme); 
      parts.push("theme"); 
    }
    if (data.language) { 
      localStorage.setItem("sv-lang", data.language); 
      setLang(data.language); 
      parts.push("language"); 
    }
    if (data.hiddenCats) { 
      db.set("sv-hiddenCats", data.hiddenCats); 
      setHiddenCats(data.hiddenCats); 
    }
    if (data.epgURL) { 
      db.set("sv-epgURL", data.epgURL); 
      setEpgURL(data.epgURL); 
    }

    // 3. Import per-connection favorites and history
    if (data.favorites) {
      for (const [connId, fv] of Object.entries(data.favorites)) {
        const existing = await db.get(`sv-favs-${connId}`, null);
        if (!existing || (Object.keys(existing.live||{}).length === 0 && Object.keys(existing.vod||{}).length === 0)) {
          db.set(`sv-favs-${connId}`, fv);
          if (authUser) syncToServer("favorites", connId, fv);
          favCount++;
        }
      }
    }
    if (data.history) {
      for (const [connId, hi] of Object.entries(data.history)) {
        const existing = await db.get(`sv-history-${connId}`, null);
        if (!existing || existing.length === 0) {
          db.set(`sv-history-${connId}`, hi);
          if (authUser) syncToServer("history", connId, hi);
          histCount++;
        }
      }
    }

    if (favCount) parts.push(`${favCount} favorite sets`);
    if (histCount) parts.push(`${histCount} history sets`);
    
    return parts.join(", ") || "preferences";
  }

  async function validateImportItem(d) {
    if (d.type === "xtream") {
      if (!d.server || !d.user || !d.pass) return { valid: false, reason: "Missing Xtream fields" };
      try {
        const server = d.server.trim().replace(/\/$/, "");
        const data = await makeXtreamAPI(server, d.user, d.pass).auth();
        const status = String(data?.user_info?.status ?? "").trim().toLowerCase();
        if (data?.user_info?.auth !== 1 || ["disabled", "expired", "blocked", "suspended", "0"].includes(status)) return { valid: false, reason: "Invalid credentials or disabled account" };
        return { valid: true };
      } catch (e) { return { valid: false, reason: `Cannot reach server: ${e.message}` }; }
    }
    if (d.type === "stalker") {
      if (!d.server || !d.mac) return { valid: false, reason: "Missing portal URL or MAC" };
      try {
        const vRes = await fetch(`${API}/stalker/validate`, { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ portal: d.server.trim().replace(/\/$/, ""), mac: d.mac.trim(), serial: d.serial, deviceId: d.deviceId, deviceId2: d.deviceId2 }) });
        const v = await vRes.json();
        if (!v.portalReachable) return { valid: false, reason: v.error || "Portal unreachable" };
        if (v.status === "expired") return { valid: false, reason: `Account expired${v.expiry ? ` on ${v.expiry}` : ""}. Contact your provider.` };
        if (v.status === "blocked") return { valid: false, reason: "Account is blocked. Contact your provider." };
        if (v.status === "suspended") return { valid: false, reason: "Account is suspended. Contact your provider." };
        if (v.status === "unregistered") return { valid: false, reason: "MAC address is not registered with this portal." };
        return { valid: true };
      } catch (e) { return { valid: false, reason: `Validation failed: ${e.message}` }; }
    }
    return { valid: true, skipped: true };
  }

  async function applyImportConfigs(configs) {
    const maxConns = userLimits?.maxConnections ?? 5;
    let newConns = [...connections];
    const usedColors = new Set(newConns.map(c => c.color));
    let added = 0;
    for (const cfg of configs) {
      if (newConns.length >= maxConns) break;
      const cId = connId(cfg);
      if (!cId || newConns.find(c => c.id === cId)) continue;
      const color = PROFILE_COLORS.find(c => !usedColors.has(c)) || PROFILE_COLORS[newConns.length % PROFILE_COLORS.length];
      usedColors.add(color);
      newConns.push({ id: cId, type: cfg.type, label: makeConnectionLabel(cfg.type, cfg), color, config: cfg });
      added++;
    }
    if (added < configs.length) alert(`Imported ${added} of ${configs.length} connections (limit: ${maxConns}). Remove existing connections to add more.`);
    setConnections(newConns);
    if (added > 0) {
      const firstAdded = newConns[newConns.length - added];
      if (firstAdded) {
        setContentSessionOpening(true);
        setConnError("");
        try {
          const opened = await maybeOpenDirectContentSession(firstAdded, { location: window.location });
          if (!opened) {
            setActiveConnId(firstAdded.id);
            setConn(firstAdded.config);
          }
        } catch (error) {
          setConnError(error?.message || "Unable to open the imported connection");
        } finally {
          setContentSessionOpening(false);
        }
      }
    }
  }

  async function handleImportMultiple(items) {
    if (!items.length || importing) return;
    setImporting(true);
    try {
      const results = await Promise.all(items.map(validateImportItem));
      const failed = items.map((d, i) => ({ d, r: results[i] })).filter(({ r }) => !r.valid);
      if (failed.length) {
        setImportPrompt({ items, failed });
        return;
      }
      await applyImportConfigs(items.map(d => d.type === "stalker"
        ? { type: d.type, server: d.server, mac: d.mac, serial: d.serial, deviceId: d.deviceId, deviceId2: d.deviceId2 }
        : d.type === "xtream" ? { type: d.type, server: d.server, user: d.user, pass: d.pass }
        : { type: d.type, url: d.url }));
    } finally { setImporting(false); }
  }

  // Auth gate: show login/register before anything else
  if (authLoading) return (<><style>{genCSS(THEMES[themeName])}</style><div className="setup"><div className="card" style={{textAlign:"center",padding:"3rem"}}><div className="spinner" /></div></div></>);
  if (!httpContentMode && !authUser && !isGuest) return (
    <>
      <style>{genCSS(THEMES[themeName])}</style>
      <AuthScreen onAuth={handleAuth} onGuest={handleGuest} api={API} />
      {resetToken && createPortal(<ResetPasswordModal token={resetToken} onClose={() => setResetToken(null)} />, document.body)}
    </>
  );

  if (httpContentMode && contentSessionLoading && !conn && !contentSessionError) {
    return (
      <div className="app" style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem" }}>
        <div style={{ width: "100%", maxWidth: 360, textAlign: "center", background: "var(--s1, #111)", border: "1px solid var(--b1, rgba(255,255,255,0.08))", borderRadius: 16, padding: "2rem" }}>
          <div className="spinner" style={{ margin: "0 auto 1rem" }} />
          <div style={{ color: "var(--t2, #9aa)", fontSize: ".9rem" }}>Loading content session...</div>
        </div>
      </div>
    );
  }

  if (httpContentMode && contentSessionError) {
    return (
      <div className="app" style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem", textAlign: "center" }}>
        <div style={{ maxWidth: 520, width: "100%", background: "var(--s1, #111)", border: "1px solid var(--b1, rgba(255,255,255,0.08))", borderRadius: 16, padding: "1.5rem" }}>
          <div style={{ fontSize: "1.1rem", fontWeight: 700, marginBottom: ".5rem" }}>Unable to open content session</div>
          <div style={{ color: "var(--t2, #9aa)", fontSize: ".9rem", lineHeight: 1.6, marginBottom: "1rem" }}>{contentSessionError}</div>
          <div style={{ display: "flex", gap: ".5rem", justifyContent: "center", flexWrap: "wrap" }}>
            <button
              className="btn-primary"
              onClick={() => setContentSessionRetryKey(key => key + 1)}
              style={{ minWidth: 140 }}
            >
              Try Again
            </button>
            <button
              onClick={leaveContentForConnectionChange}
              style={{ minWidth: 180, background: "transparent", border: "1px solid var(--b2)", color: "var(--t1)" }}
            >
              Return to Secure Setup
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!conn) return (
    <>
      <style>{genCSS(THEMES[themeName])}</style>
      <Setup 
        onConnect={handleConnect} 
        onImportMultiple={handleImportMultiple} 
        onImportFull={processFullImport}
        connections={connections} 
        onReconnect={switchConnection} 
        onRemoveConn={removeConnection} 
        onEdit={setEditingConn} 
        authUser={authUser} 
        isGuest={isGuest} 
        onLogout={handleLogout} 
        onAuth={handleAuth}
        themeName={themeName} themeOptions={THEME_NAMES} onThemeChange={setThemeName}
        language={lang} languageOptions={LANG_META} onLanguageChange={setLang}
        onFeedback={() => setFbOpen(true)} maxConnections={userLimits?.maxConnections ?? 5}
        autoLoadMore={autoLoadMore} setAutoLoadMore={setAutoLoadMore}
        t={t} 
      />
            {importPrompt && createPortal(
        <ImportConfirmModal
          prompt={importPrompt}
          importing={importing}
          onCancel={() => setImportPrompt(null)}
          onProceed={async () => {
            const items = importPrompt.items;
            setImportPrompt(null);
            await applyImportConfigs(items.map(d => d.type === "stalker"
              ? { type: d.type, server: d.server, mac: d.mac, serial: d.serial, deviceId: d.deviceId, deviceId2: d.deviceId2 }
              : d.type === "xtream" ? { type: d.type, server: d.server, user: d.user, pass: d.pass }
              : { type: d.type, url: d.url }));
          }}
        />,
        document.body
      )}
            {/* Feedback widget on Setup screen too */}
      <button onClick={() => setFbOpen(true)} title="Send feedback"
        style={{position:"fixed",bottom:18,right:18,zIndex:9998,width:42,height:42,borderRadius:"50%",
          background:"var(--s2,#16162a)",border:"1px solid rgba(255,255,255,0.1)",color:"var(--accent,#00d4ff)",
          cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",
          boxShadow:"0 2px 12px rgba(0,0,0,0.4)"}}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </button>
      {fbOpen && createPortal(
        <div style={{position:"fixed",inset:0,zIndex:99999,background:"rgba(0,0,0,0.6)",
          display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}
          onClick={e => { if (e.target === e.currentTarget && !fbSending) { setFbOpen(false); setFbMsg(""); setFbDone(false); }}}>
          <div style={{background:"var(--s1,#0f0f1c)",border:"1px solid rgba(255,255,255,0.08)",
            borderRadius:14,padding:"1.5rem",width:"100%",maxWidth:420,boxShadow:"0 8px 32px rgba(0,0,0,0.5)"}}>
            {fbDone ? (
              <div style={{textAlign:"center",padding:"2rem 0"}}>
                <div style={{fontSize:"1.5rem",marginBottom:".5rem"}}>{t("thankYou")}</div>
                <div style={{color:"var(--t2,#8080aa)",fontSize:".85rem"}}>{t("feedbackReceived")}</div>
              </div>
            ) : (
              <>
                <div style={{fontSize:"1.05rem",fontWeight:600,marginBottom:".2rem"}}>{t("sendFeedback")}</div>
                <div style={{fontSize:".75rem",color:"var(--t2,#8080aa)",marginBottom:"1rem"}}>{t("feedbackHint")}</div>
                <textarea value={fbMsg} onChange={e => setFbMsg(e.target.value)} placeholder={t("feedbackPlaceholder")} maxLength={2000}
                  style={{width:"100%",minHeight:120,background:"var(--s2,#16162a)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:".75rem",
                    color:"var(--t1,#dde0f5)",fontSize:".85rem",resize:"vertical",fontFamily:"inherit",outline:"none"}} autoFocus />
                <div style={{display:"flex",justifyContent:"flex-end",gap:".5rem",marginTop:".8rem"}}>
                  <button onClick={() => { setFbOpen(false); setFbMsg(""); }}
                    style={{padding:".45rem 1rem",background:"transparent",border:"1px solid rgba(255,255,255,0.1)",borderRadius:7,color:"var(--t2,#8080aa)",fontSize:".8rem",cursor:"pointer"}}>{t("cancel")}</button>
                  <button onClick={sendFeedback} disabled={!fbMsg.trim() || fbSending}
                    style={{padding:".45rem 1rem",background:!fbMsg.trim()||fbSending?"rgba(255,255,255,0.05)":"var(--accent,#00d4ff)",border:"none",borderRadius:7,
                      color:!fbMsg.trim()||fbSending?"var(--t3,#44445a)":"#fff",fontSize:".8rem",fontWeight:600,cursor:!fbMsg.trim()||fbSending?"default":"pointer"}}>
                    {fbSending ? t("sending") : t("send")}</button>
                </div>
              </>
            )}
          </div>
        </div>
      , document.body)}
      {editingConn && createPortal(
        <EditConnectionModal
          conn={editingConn}
          onClose={() => setEditingConn(null)}
          onSave={handleEditConnection}
          t={t}
        />
      , document.body)}
    </>
  );

  return (
    <div className="app" dir={isRTL ? "rtl" : "ltr"}>
      {playbackLoading && (
        <PlaybackLoadingOverlay
          message={`Connecting to ${playbackLoading.name || "stream"}...`}
          onCancel={cancelPlaybackResolve}
        />
      )}
      <AdsterraSocialBar onAllowedPage={onAllowedPage} isAdEligible={isAdEligible} />
      <HilltopPushAd onAllowedPage={onAllowedPage} isAdEligible={isAdEligible} />
      {/* ── MOBILE TOP BAR + DRAWER ── */}
      <div className="mob-topbar">
        <button className="mob-hamburger" onClick={() => setMobileMenuOpen(true)}>☰</button>
        <span className="mob-topbar-title">Portal Heaven</span>
        <span className="mob-topbar-section">{LABEL[section]}</span>
      </div>
      <div className={`mob-overlay ${mobileMenuOpen?"open":""}`} onClick={() => setMobileMenuOpen(false)} />
      <div className={`mob-drawer ${mobileMenuOpen?"open":""}`}>
        <div className="s-logo">Portal Heaven</div>
        {activeConnection && (
          <div className="conn-card" style={{borderLeftColor: activeConnection.color}}
            onClick={() => { leaveContentForConnectionChange(); setMobileMenuOpen(false); }}>
            <div className="conn-card-row">
              <span className="conn-card-icon">{CONN_ICONS[activeConnection.type] || "📡"}</span>
              <div className="conn-card-info">
                <div className="conn-card-label">{activeConnection.label}</div>
                <div className="conn-card-stats">{channelCount.toLocaleString()} items</div>
              </div>
            </div>
          </div>
        )}
        <div className="theme-row">
          {THEME_NAMES.map(tn => (
            <div key={tn} className={`theme-swatch ${themeName===tn?"on":""}`}
              style={{background:THEMES[tn].accent}} title={tn}
              onClick={() => setThemeName(tn)} />
          ))}
        </div>
        {["watch","tools"].map(sKey => (
          <div key={sKey}>
            <div className="s-sect">{t(sKey)}</div>
            {NAV.filter(n=>n.sKey===sKey).map(n => (
              <div key={n.key} className={`nav ${section===n.key?"on":""}`}
                onClick={() => { switchSection(n.key); setMobileMenuOpen(false); }}>
                <span className="nav-icon">{n.icon}</span>
                <span>{t(n.tKey)}</span>
                {n.key==="favs" && totalFavs > 0 && <span className="nav-badge">{totalFavs}</span>}
                {n.key==="continue" && continueItems.length > 0 && <span className="nav-badge">{continueItems.length}</span>}
              </div>
            ))}
          </div>
        ))}
        <div className="s-bottom">
          {authUser && (
            <div style={{fontSize:".72rem",color:"var(--t3)",padding:"0 0 .4rem",display:"flex",alignItems:"center",gap:".3rem"}}>
              <span style={{color:"var(--accent)"}}>●</span> {authUser.username} <span style={{textTransform:"capitalize",opacity:.7}}>({authUser.role})</span>
            </div>
          )}
          <div className="s-row">
            <button className="btn-sm" onClick={() => { setFbOpen(true); setMobileMenuOpen(false); }}>💬 {t("feedback")}</button>
            <button className="btn-sm danger" onClick={() => { disconnect(); setMobileMenuOpen(false); }}>⏏ {t("disconnect")}</button>
          </div>
          {(authUser || isGuest) && (
            <div style={{marginTop:".4rem"}}>
              <button className="btn-sm" style={{width:"100%",fontSize:".72rem"}} onClick={() => { handleLogout(); setMobileMenuOpen(false); }}>
                {authUser ? "🚪 Logout" : "🔑 Login"}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── SIDEBAR (desktop only) ── */}
      <div className="sidebar">
        <div className="s-logo">Portal Heaven</div>

        {/* Connection Card */}
        {activeConnection && (
          <div className="conn-card" style={{borderLeftColor: activeConnection.color}}
            onClick={leaveContentForConnectionChange} title="Switch connection">
            <div className="conn-card-row">
              <span className="conn-card-icon">{CONN_ICONS[activeConnection.type] || "📡"}</span>
              <div className="conn-card-info">
                <div className="conn-card-label">{activeConnection.label}</div>
                <div className="conn-card-stats">{channelCount.toLocaleString()} items</div>
                {activeConnection?.config?.accountInfo?.daysLeft !== null && activeConnection?.config?.accountInfo?.daysLeft !== undefined && (
                  <div style={{fontSize:".62rem", color: activeConnection.config.accountInfo.daysLeft <= 7 ? "var(--danger)" : "var(--t3)", marginTop:".15rem"}}>
                    {activeConnection.config.accountInfo.status === "active"
                      ? `${activeConnection.config.accountInfo.daysLeft}d left${activeConnection.config.accountInfo.tariff ? ` · ${activeConnection.config.accountInfo.tariff}` : ""}`
                      : activeConnection.config.accountInfo.status}
                  </div>
                )}
              </div>
            </div>
            <div className="conn-card-switch">▼ {t("switchConn")}</div>
          </div>
        )}

        {/* Themes */}
        <div className="theme-row">
          {THEME_NAMES.map(tn => (
            <div key={tn} className={`theme-swatch ${themeName===tn?"on":""}`}
              style={{background:THEMES[tn].accent}}
              title={tn}
              onClick={() => setThemeName(tn)} />
          ))}
        </div>

        {/* Language Selector */}
        <div className="lang-sel">
          <div className="lang-sel-label">{t("language")}</div>
          <select value={lang} onChange={e => setLang(e.target.value)}>
            {Object.entries(LANG_META).map(([code, name]) => (
              <option key={code} value={code}>{name}</option>
            ))}
          </select>
        </div>

        {/* Nav */}
        {["watch","tools"].map(sKey => (
          <div key={sKey}>
            <div className="s-sect">{t(sKey)}</div>
            {NAV.filter(n=>n.sKey===sKey).map(n => (
              <div key={n.key} className={`nav ${section===n.key?"on":""}`} onClick={() => switchSection(n.key)}>
                <span className="nav-icon">{n.icon}</span>
                <span>{t(n.tKey)}</span>
                {n.key==="favs" && totalFavs > 0 && <span className="nav-badge">{totalFavs}</span>}
                {n.key==="continue" && continueItems.length > 0 && <span className="nav-badge">{continueItems.length}</span>}
              </div>
            ))}
          </div>
        ))}

        <div className="s-bottom">
          {authUser && (
            <div style={{fontSize:".68rem",color:"var(--t3)",padding:"0 0 .4rem",display:"flex",alignItems:"center",gap:".3rem"}}>
              <span style={{color:"var(--accent)"}}>●</span> {authUser.username} <span style={{textTransform:"capitalize",opacity:.7}}>({authUser.role})</span>
            </div>
          )}
          {isGuest && (
            <div style={{fontSize:".68rem",color:"var(--t3)",padding:"0 0 .4rem"}}>
              <span style={{color:"var(--t3)"}}>●</span> Guest — <button onClick={() => { handleLogout(); }}
                style={{background:"none",border:"none",color:"var(--accent)",cursor:"pointer",fontSize:".68rem",padding:0,fontFamily:"inherit",textDecoration:"underline"}}>
                Login for more features</button>
            </div>
          )}
          <div className="s-row">
            <button className="btn-sm" onClick={() => setFbOpen(true)}>💬 {t("feedback")}</button>
            <button className="btn-sm danger" onClick={disconnect}>⏏ {t("disconnect")}</button>
          </div>
          {(authUser || isGuest) && (
            <div style={{marginTop:".4rem"}}>
              <button className="btn-sm" style={{width:"100%",fontSize:".68rem"}} onClick={() => { handleLogout(); }}>
                {authUser ? "🚪 Logout" : "🔑 Login"}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── CONTENT ── */}
      <div className="content">
        {/* Error banner */}
        {connError && (
          <div style={{background:"var(--danger)",color:"#fff",padding:".5rem 1rem",fontSize:".78rem",
            display:"flex",alignItems:"center",gap:".5rem",margin:"0 0 .5rem",borderRadius:"6px"}}>
            <span style={{flex:1}}>⚠️ {connError}</span>
            <button onClick={() => setConnError("")} style={{background:"none",border:"none",color:"#fff",
              cursor:"pointer",fontSize:"1rem",padding:0,lineHeight:1}}>✕</button>
          </div>
        )}
        {/* Header */}
        <div className="c-header">
          <span className="c-title">
            {LABEL[section]}
            {["live","vod","series"].includes(section) && curItems.length > 0 &&
              <span className="c-count">{lazyState?.totalKnown ? `${curItems.length.toLocaleString()} of ${Number(lazyState.total).toLocaleString()}` : `${curItems.length.toLocaleString()} items`}</span>}
          </span>
          {section==="live" && (
            <span style={{fontSize:".73rem"}}><span className="live-dot" />LIVE</span>
          )}
          {section === "live" && epgSources.length > 0 && (
            <select className="fi" style={{width:130,padding:".25rem",fontSize:".72rem"}} 
              value={activeEpgSource} onChange={e=>setActiveEpgSource(e.target.value)}>
              <option value="all">All</option>
              {epgSources.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          )}
          {["live","vod","series"].includes(section) && (            <>
              {conn?.type === "stalker" && (
                <>
                  <button className="c-btn" title="Reload from portal" onClick={() => {
                    if (section === "live") { setChannels([]); fetchStalkerChannels(true); }
                    else if (section === "vod" || section === "series") {
                      setVod(section === "vod" ? [] : vod);
                      setSeries(section === "series" ? [] : series);
                      if (section === "vod") setStalkerVodCats([]); else setStalkerSeriesCats([]);
                      fetchingCatRef.current.clear();
                      setCat(null);
                      loadStalkerCats(section, true);
                    }
                  }}>↺ {t("refresh")}</button>
                  {prefetchProgress && (
                    <span style={{fontSize:".68rem",color:"var(--t3)",whiteSpace:"nowrap"}}>
                      Loading {prefetchProgress.done}/{prefetchProgress.total} categories…
                    </span>
                  )}
                </>
              )}
              {conn?.type === "xtream" && (
                <button className="c-btn" title="Reload from provider" onClick={() => {
                  if (section === "live") { setChannels([]); fetchLive(true); }
                  else if (section === "vod") { setVod([]); fetchVOD(true); }
                  else if (section === "series") { setSeries([]); fetchSeries(true); }
                }}>↺ {t("refresh")}</button>
              )}
              {conn?.type === "m3u" && section === "live" && (
                <button className="c-btn" title="Re-fetch M3U playlist" onClick={async () => {
                  try {
                    setLoading(true);
                    const res = await proxyFetch(conn.url);
                    const text = await res.text();
                    const chs = parseM3U(text);
                    setChannels(chs);
                    const cId = connId(conn);
                    if (cId) {
                      idbCache.set(`content:${cId}:live`, chs);
                      setLastSynced(prev => ({ ...prev, live: Date.now() }));
                    }
                  } catch(e) { console.error("M3U refresh error:", e); }
                  finally { setLoading(false); }
                }}>↺ {t("refresh")}</button>
              )}
              {lastSynced[section] && (
                <span style={{fontSize:".62rem",color:"var(--t3)",whiteSpace:"nowrap"}} title={new Date(lastSynced[section]).toLocaleString()}>
                  {t("synced")} {(() => {
                    const mins = Math.floor((Date.now() - lastSynced[section]) / 60000);
                    if (mins < 1) return t("justNow");
                    if (mins < 60) return `${mins}m ago`;
                    const hrs = Math.floor(mins / 60);
                    if (hrs < 24) return `${hrs}h ago`;
                    return `${Math.floor(hrs / 24)}d ago`;
                  })()}
                </span>
              )}
              <div className="c-search-wrap">
                <span className="c-search-icon">🔍</span>
                <input className="c-search" placeholder={`${t("search")} ${LABEL[section]}…`}
                  value={search} onChange={e => handleSearch(e.target.value)} />
              </div>
            </>
          )}
          {section==="search" && (
            <div className="c-search-wrap" style={{flex:1}}>
              <span className="c-search-icon">🔍</span>
              <input className="c-search" style={{width:"100%"}} placeholder={t("searchEverything")}
                autoFocus
                value={globalQ} onChange={e => handleGlobalSearch(e.target.value)} />
            </div>
          )}
        </div>

        {/* Body */}
        {loading ? (
          <div className="loading" role="status" aria-live="polite"><div className="spinner" /><div style={{width:"min(360px, 72vw)", display:"flex", flexDirection:"column", gap:".45rem"}}><div style={{height:"6px", width:"100%", background:"var(--s2)", borderRadius:"999px", overflow:"hidden"}}><div style={{height:"100%", width:(contentLoad?.value ?? 24)+"%", background:"var(--accent)", borderRadius:"999px", transition:"width .35s ease"}} /></div><span>{contentLoad?.label || t("loadingSection", LABEL[section])}</span></div></div>
        ) : section==="discover" ? (
          <DiscoverView
            tmdbKey={tmdbKey}
            setTmdbKey={setTmdbKey}
            vod={vod}
            series={series}
            onPlay={playItem}
            stalkerDiscoveryEnabled={STALKER_LAZY_ENABLED && conn?.type === "stalker"}
            stalkerDiscoveryItems={stalkerDiscoveryItems}
            stalkerDiscoveryLoading={stalkerDiscoveryLoading}
            stalkerDiscoveryError={stalkerDiscoveryError}
            stalkerDiscoveryPartial={stalkerDiscoveryPartial}
            onLoadStalkerDiscovery={loadStalkerDiscovery}
          />
        ) : section==="settings" ? (
          <SettingsView connections={connections}
            authUser={authUser} activeConnId={activeConnId}
            onAuth={handleAuth} onImportFull={processFullImport} autoLoadMore={autoLoadMore} setAutoLoadMore={setAutoLoadMore}
            contentMode={httpContentMode}
            onOpenSecureSettings={() => window.location.assign(`${getAppHomeUrl()}?section=settings&settingsTab=data`)}
            themeName={themeName} themeOptions={THEME_NAMES} onThemeChange={setThemeName}
            language={lang} languageOptions={LANG_META} onLanguageChange={setLang}
            onFeedback={() => setFbOpen(true)} onLogout={handleLogout} maxConnections={userLimits?.maxConnections ?? 5} />

        ) : section==="hls" ? (
          <DirectHLSView />
        ) : section==="epg" ? (
          <EPGView channels={channels} epgData={epgData} epgURL={epgURL} setEpgURL={setEpgURL}
            epgSources={epgSources} activeEpgSource={activeEpgSource} setActiveEpgSource={setActiveEpgSource}
            epgLoading={epgLoading} loadEPG={loadEPG} onPlay={playItem} onPlayCatchup={playCatchup} showCatchup={conn?.type === "stalker"} t={t} />
        ) : section==="search" ? (
          <GlobalSearch results={searchResults} query={globalQ} onPlay={playItem} toggleFav={toggleFav} isFav={isFav} t={t} limited={stalkerSearchLimited} />
        ) : section==="favs" ? (
          <FavsView favItems={favItems} onPlay={playItem} toggleFav={toggleFav} isFav={isFav} t={t} />
        ) : section==="continue" ? (
          <ContinueView items={continueItems} onPlay={playItem} history={history} t={t} />
        ) : (
          <div className="c-body" key={`${section}:${cat}`}>
            {/* Categories sidebar */}
            {curCats.length > 1 && (
              <div className="cats" onContextMenu={(e) => {
                if (e.target === e.currentTarget) {
                  e.preventDefault();
                  setCtx({x:e.clientX, y:e.clientY, sec:section, type: "container"});
                }
              }}>
                <div style={{ padding: "0.5rem", position: "sticky", top: 0, background: "var(--bg)", zIndex: 10, borderBottom: "1px solid var(--b1)" }}>
                  <input
                    className="fi"
                    style={{ width: "100%", padding: "0.4rem", fontSize: "0.75rem", borderRadius: "4px" }}
                    placeholder="Filter categories…"
                    value={catSearch}
                    onChange={e => setCatSearch(e.target.value)}
                  />
                </div>
                {curCats
                  .filter(c => c === "All" || !isCatHidden(section, c))
                  .filter(c => !catSearch || c.toLowerCase().includes(catSearch.toLowerCase()))
                  .map(c => {
                  return (                    <div key={c}
                      className={`cat ${cat===c?"on":""}`}
                      title={c}
                      onClick={() => {
                        setCat(c); setPage(1);
                        if (conn?.type === "stalker" && (section === "live" || section === "vod" || section === "series")) {
                          const apiCats = section === "live" ? stalkerLiveCats : section === "vod" ? stalkerVodCats : stalkerSeriesCats;
                          const catObj = apiCats.find(sc => sc.title === c);
                          if (catObj) {
                            if (section === "live") loadStalkerLiveCategoryItems(catObj.id, c);
                            else loadStalkerCatItems(section, catObj.id, c);
                          }
                        }
                      }}
                      onContextMenu={e => {
                        e.stopPropagation();
                        e.preventDefault();
                        if (c !== "All") setCtx({x:e.clientX, y:e.clientY, sec:section, catName:c, type: "item"});
                        else setCtx({x:e.clientX, y:e.clientY, sec:section, type: "container"});
                      }}>
                      {c}
                    </div>
                  );
                })}
              </div>
            )}

            {cat === null && conn?.type === "stalker" && (section === "vod" || section === "series") ? (
              <div className="empty">
                <div className="empty-icon">📂</div>
                <div className="empty-t">{t("selectCategory")}</div>
                <div className="empty-s">{t("chooseCategory")}</div>
              </div>
            ) : catLoading && curItems.length === 0 ? (
              <div className="empty">
                <div className="empty-icon" style={{animation:"spin 1s linear infinite"}}>⏳</div>
                <div className="empty-t">{t("loadingSection", cat)}</div>
                <div className="empty-s">{t("fetchingItems")}</div>
              </div>
            ) : curItems.length === 0 ? (
              <div className="empty">
                <div className="empty-icon">
                  {section === "vod" && vodSyncing ? "🔄" : section === "series" && seriesSyncing ? "🔄" : section === "live" ? "📺" : section === "vod" ? "🎬" : "📽"}
                </div>
                <div className="empty-t">
                  {section === "vod" && vodSyncing ? "Synchronizing VOD library..." : section === "series" && seriesSyncing ? "Synchronizing Series library..." : t("noContent")}
                </div>
                <div className="empty-s" style={{maxWidth: "400px", margin: "0 auto", lineHeight: "1.5"}}>
                  {section === "vod" && vodSyncing || section === "series" && seriesSyncing
                    ? "Downloading data from provider in the background. Massive libraries (100k+ items) may take up to 5 minutes to generate on the provider's end."
                    : conn.type === "stalker" ? t("stalkerHint") : t("tryDifferent")}
                </div>
              </div>
            ) : (
                <>
                  {section==="live" ? (
                  <div
                    ref={contentScrollRef}
                    onScroll={handleContentScroll}
                    style={{flex:1,display:"flex",flexDirection:"column",overflow:"auto",minHeight:0}}
                  >
                    <div key="live-wrapper" className="live-timeline-wrapper" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                      <TimelineGrid
                        key={activeEpgSource}
                        ref={liveGridRef}
                        channels={paginatedItems}
                        epgData={epgData}
                        onPlay={playItem}
                        onPlayCatchup={playCatchup}
                        hasMore={hasMore}
                        onLoadMore={() => STALKER_LAZY_ENABLED && conn?.type === "stalker" ? loadNextStalkerPage("live") : setPage(p=>p+1)}
                        loadText={`${t("loadMore")} (${paginatedItems.length}/${curItems.length})`}
                      />
                    </div>
                    {hasMore && section !== "live" && (
                      <div style={{display:"flex",alignItems:"center",justifyContent:"center",padding:".75rem 0",width:"100%",flexShrink:0}}>
                        <button className="c-btn" onClick={()=>setPage(p=>p+1)}>{t("loadMore")} ({paginatedItems.length}/{curItems.length})</button>
                      </div>
                    )}
                  </div>
                ) : (
                  <VirtualGrid 
                    key={section + cat + search}
                    items={curItems}
                    section={section}
                    isFav={isFav}
                    historyMap={historyMap}
                    playItem={playItem}
                    toggleFav={toggleFav}
                    setExpandedItem={setExpandedItem}
                    imgSrc={imgSrc}
                    canLoadMore={STALKER_LAZY_ENABLED && conn?.type === "stalker" && Boolean(stalkerPageRef.current.get(`${section}:${section === "live"
                      ? stalkerLiveCategoryRef.current.id
                      : ((section === "vod" ? stalkerVodCats : stalkerSeriesCats).find(item => item.title === cat)?.id || "all")}`)?.hasMore)}
                    onEndReached={() => loadNextStalkerPage(section)}
                    header={
                      recommendations.length > 0 && !search && cat === "All" && (
                        <div style={{marginBottom:".8rem",flexShrink:0}}>
                          <div style={{fontSize:".78rem",fontWeight:600,color:"var(--t2)",marginBottom:".4rem",paddingLeft:".2rem"}}>
                            Recommended for you
                          </div>
                          <div style={{display:"flex",gap:".5rem",overflowX:"auto",paddingBottom:".4rem"}}>
                            {recommendations.map((item, i) => (
                              <div key={item.id||i} style={{flexShrink:0,width:110,cursor:"pointer"}} onClick={() => playItem(item)}>
                                {item.logo
                                  ? <img src={imgSrc(item.logo)} alt="" style={{width:110,aspectRatio:"2/3",objectFit:"cover",borderRadius:8,background:"var(--s2)",display:"block"}} onError={e=>e.target.style.display="none"} />
                                  : <div style={{width:110,aspectRatio:"2/3",background:"var(--s2)",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",fontSize:"1.4rem"}}>{section==="series"?"📽":"🎬"}</div>}
                                <div style={{fontSize:".65rem",marginTop:".2rem",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:"var(--t2)"}}>{item.name}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    }
                  />
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── PLAYER ── */}
      {/* Detail popup modal */}
      {expandedItem && createPortal(
        <div style={{position:"fixed",inset:0,zIndex:99998,background:"rgba(0,0,0,0.65)",
          display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}
          onClick={e => { if (e.target === e.currentTarget) { setExpandedItem(null); setShowTrailer(false); } }}>
          <div style={{background:"var(--s1,#0f0f1c)",border:"1px solid rgba(255,255,255,0.08)",
            borderRadius:16,padding:"1.5rem",boxShadow:"0 12px 48px rgba(0,0,0,0.6)",maxWidth:560,width:"100%",
            maxHeight:"90vh",overflowY:"auto"}}>
            <div className="detail-modal">
              {(tmdbData?.poster || expandedItem.logo)
                ? <img className="detail-poster" loading="lazy" src={tmdbData?.poster || imgSrc(expandedItem.logo)} alt="" onError={e=>e.target.style.display="none"} />
                : <div className="detail-poster-ph">{expandedItem.type==="series"?"📽":"🎬"}</div>}
              <div className="detail-body">
                <div className="detail-title">{expandedItem.name}</div>
                <div className="detail-meta">
                  {expandedItem.year && <span>{expandedItem.year}</span>}
                  {expandedItem.rating && <span>★ {parseFloat(expandedItem.rating||0).toFixed(1)}</span>}
                  {tmdbData?.voteAverage && !expandedItem.rating && <span className="detail-tmdb-rating">★ {tmdbData.voteAverage.toFixed(1)}</span>}
                  {tmdbData?.voteAverage && expandedItem.rating && <span className="detail-tmdb-rating">TMDB ★ {tmdbData.voteAverage.toFixed(1)}</span>}
                  {expandedItem.duration && <span>{expandedItem.duration}</span>}
                  {!expandedItem.duration && tmdbData?.runtime && <span>{tmdbData.runtime} min</span>}
                  {expandedItem.age && <span>{expandedItem.age}</span>}
                  {expandedItem.type && <span style={{textTransform:"uppercase"}}>{expandedItem.type}</span>}
                </div>
                {tmdbData?.tagline && <div className="detail-tagline">{tmdbData.tagline}</div>}
                {(expandedItem.plot || tmdbData?.overview) && <div className="detail-plot">{expandedItem.plot || tmdbData.overview}</div>}
                {tmdbData?.genres?.length > 0 && (
                  <div className="detail-genres">{tmdbData.genres.map(g => <span key={g}>{g}</span>)}</div>
                )}
                {!tmdbData?.genres?.length && expandedItem.genre && <div className="detail-row"><span className="detail-label">Genre</span><span className="detail-val">{expandedItem.genre}</span></div>}
                {(expandedItem.director || tmdbData?.director) && <div className="detail-row"><span className="detail-label">Director</span><span className="detail-val">{expandedItem.director || tmdbData.director}</span></div>}
                {!tmdbData?.cast?.length && expandedItem.actors && <div className="detail-row"><span className="detail-label">Cast</span><span className="detail-val">{expandedItem.actors}</span></div>}
                {expandedItem.country && <div className="detail-row"><span className="detail-label">Country</span><span className="detail-val">{expandedItem.country}</span></div>}
                {tmdbData?.cast?.length > 0 && (
                  <div className="detail-cast">
                    {tmdbData.cast.map((c, i) => (
                      <div className="detail-cast-item" key={i}>
                        {c.photo
                          ? <img className="detail-cast-photo" src={c.photo} alt={c.name} />
                          : <div className="detail-cast-photo-ph">👤</div>}
                        <div className="detail-cast-name">{c.name}</div>
                        {c.character && <div className="detail-cast-char">{c.character}</div>}
                      </div>
                    ))}
                  </div>
                )}
                {!tmdbData && tmdbKey && <div className="detail-loading">Loading TMDB...</div>}
                <div className="detail-actions">
                  <button className="detail-play" onClick={()=>{setExpandedItem(null);setShowTrailer(false);playItem(expandedItem);}}>▶ Play</button>
                  <button className="detail-fav" onClick={()=>toggleFav(expandedItem)}>
                    {isFav(expandedItem) ? "♥ Favorited" : "♡ Favorite"}
                  </button>
                  {tmdbData?.trailer && (
                    <button className="detail-trailer-btn" style={{padding:".5rem 1rem",borderRadius:8,fontSize:".82rem",cursor:"pointer",transition:"all .15s"}}
                      onClick={() => setShowTrailer(v => !v)}>
                      {showTrailer ? "✕ Close Trailer" : "▶ Trailer"}
                    </button>
                  )}
                </div>
                {showTrailer && tmdbData?.trailer && (
                  <iframe className="detail-trailer" src={`${tmdbData.trailer}?autoplay=1`}
                    allow="autoplay; encrypted-media" allowFullScreen title="Trailer" />
                )}
              </div>
            </div>
          </div>
        </div>
      , document.body)}

      {/* Feedback modal (connected view) */}
      {fbOpen && createPortal(
        <div style={{position:"fixed",inset:0,zIndex:99999,background:"rgba(0,0,0,0.6)",
          display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}
          onClick={e => { if (e.target === e.currentTarget && !fbSending) { setFbOpen(false); setFbMsg(""); setFbDone(false); }}}>
          <div style={{background:"var(--s1,#0f0f1c)",border:"1px solid rgba(255,255,255,0.08)",
            borderRadius:14,padding:"1.5rem",width:"100%",maxWidth:420,boxShadow:"0 8px 32px rgba(0,0,0,0.5)"}}>
            {fbDone ? (
              <div style={{textAlign:"center",padding:"2rem 0"}}>
                <div style={{fontSize:"1.5rem",marginBottom:".5rem"}}>{t("thankYou")}</div>
                <div style={{color:"var(--t2,#8080aa)",fontSize:".85rem"}}>{t("feedbackReceived")}</div>
              </div>
            ) : (<>
              <div style={{fontSize:"1.05rem",fontWeight:600,marginBottom:".2rem"}}>{t("sendFeedback")}</div>
              <div style={{fontSize:".75rem",color:"var(--t2,#8080aa)",marginBottom:"1rem"}}>{t("feedbackHint")}</div>
              <textarea value={fbMsg} onChange={e => setFbMsg(e.target.value)} placeholder={t("feedbackPlaceholder")} maxLength={2000}
                style={{width:"100%",minHeight:120,background:"var(--s2,#16162a)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,padding:".75rem",
                  color:"var(--t1,#dde0f5)",fontSize:".85rem",resize:"vertical",fontFamily:"inherit",outline:"none"}} autoFocus />
              <div style={{display:"flex",justifyContent:"flex-end",gap:".5rem",marginTop:".8rem"}}>
                <button onClick={() => { setFbOpen(false); setFbMsg(""); }}
                  style={{padding:".45rem 1rem",background:"transparent",border:"1px solid rgba(255,255,255,0.1)",borderRadius:7,color:"var(--t2,#8080aa)",fontSize:".8rem",cursor:"pointer"}}>{t("cancel")}</button>
                <button onClick={sendFeedback} disabled={!fbMsg.trim() || fbSending}
                  style={{padding:".45rem 1rem",background:!fbMsg.trim()||fbSending?"rgba(255,255,255,0.05)":"var(--accent,#00d4ff)",border:"none",borderRadius:7,
                    color:!fbMsg.trim()||fbSending?"var(--t3,#44445a)":"#fff",fontSize:".8rem",fontWeight:600,cursor:!fbMsg.trim()||fbSending?"default":"pointer"}}>
                  {fbSending ? t("sending") : t("send")}</button>
              </div>
            </>)}
          </div>
        </div>
      , document.body)}

      {/* Upgrade prompt for free/guest users */}
      {showUpgradePrompt && createPortal(
        <div style={{position:"fixed",inset:0,zIndex:99999,background:"rgba(0,0,0,0.6)",
          display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}
          onClick={e => { if (e.target === e.currentTarget) setShowUpgradePrompt(false); }}>
          <div style={{background:"var(--s1,#0f0f1c)",border:"1px solid rgba(255,255,255,0.08)",
            borderRadius:14,padding:"1.5rem",width:"100%",maxWidth:420,boxShadow:"0 8px 32px rgba(0,0,0,0.5)",position:"relative"}}>
            <button onClick={() => setShowUpgradePrompt(false)} style={{position:"absolute",top:".5rem",right:".5rem",background:"none",border:"none",color:"var(--t2)",fontSize:"1.2rem",cursor:"pointer"}}>×</button>
            <div style={{fontSize:"1.2rem",fontWeight:600,marginBottom:"1rem",color:"var(--accent)"}}>✨ Upgrade Your Account</div>
            <div style={{fontSize:".85rem",color:"var(--t2)",marginBottom:"1.5rem"}}>
              Unlock premium features and enhance your streaming experience:
            </div>
            <ul style={{margin:0,paddingLeft:"1.2rem",color:"var(--t1)",fontSize:".85rem",lineHeight:1.6}}>
              <li>No ads — enjoy uninterrupted streaming</li>
              <li>More simultaneous connections</li>
              <li>Unlimited VOD library access</li>
              <li>Sync across all your devices</li>
              <li>Priority support</li>
            </ul>
            <div style={{display:"flex",justifyContent:"flex-end",gap:".5rem",marginTop:"1.5rem"}}>
              <button onClick={() => setShowUpgradePrompt(false)}
                style={{padding:".5rem 1rem",background:"transparent",border:"1px solid rgba(255,255,255,0.1)",borderRadius:7,color:"var(--t2)",fontSize:".85rem",cursor:"pointer"}}>
                Maybe Later
              </button>
              <button onClick={() => { handleLogout(); setShowUpgradePrompt(false); }}
                style={{padding:".5rem 1.2rem",background:"var(--accent,#00d4ff)",border:"none",borderRadius:7,color:"#fff",fontSize:".85rem",fontWeight:600,cursor:"pointer"}}>
                Upgrade Now
              </button>
            </div>
          </div>
        </div>
      , document.body)}

      {playing && (
        <Player item={playing}
          channelList={playing.type==="live" ? channels : null}
          epgData={epgData}
          onClose={() => setPlaying(null)}
          onRefreshStream={refreshStalkerStream}
          onRequestRelay={requestStalkerRelay}
          onPlayCatchup={playCatchup}
          onProgress={updateHistoryProgress}
          toggleFav={toggleFav}
          onFav={toggleFav}
          isFav={isFav}
          connType={conn?.type}
          t={t}
          isAdEligible={isAdEligible}
        />
      )}

      {/* ── CONTEXT MENU ── */}
      {ctx && (
        <div className="ctx-menu" style={{left:ctx.x, top:ctx.y}} onClick={e=>e.stopPropagation()}>
          {ctx.type === "container" ? (
             <div className="ctx-item" onClick={() => { setShowCatEditor(ctx.sec); setCtx(null); }}>
               📝 {t("editCategories") || "Edit Categories"}
             </div>
          ) : (
             <>
               <div className="ctx-item" onClick={() => {toggleHideCat(ctx.sec, ctx.catName);setCtx(null);}}>
                 {isCatHidden(ctx.sec, ctx.catName) ? `👁 ${t("showCategory")}` : `🙈 ${t("hideCategory")}`}
               </div>
               <div className="ctx-item" onClick={() => {setCat(ctx.catName);setCtx(null);}}>
                 📌 {t("filterToThis")}
               </div>
               <div className="ctx-item" onClick={() => { setShowCatEditor(ctx.sec); setCtx(null); }}>
                 📝 {t("editCategories") || "Edit Categories"}
               </div>
             </>
          )}
        </div>
      )}

      {/* ── SERIES DETAIL MODAL ── */}
      {seriesDetail && (
        <div className="series-modal-ov" onClick={() => { if (!seriesLoading) setSeriesDetail(null); }}>
          <div className="series-modal" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="series-modal-header">
              {seriesDetail.item.logo
                ? <img className="series-modal-poster" loading="lazy" src={imgSrc(seriesDetail.item.logo)} alt="" onError={e => e.target.style.display="none"} />
                : <div className="series-modal-poster-ph">📽</div>}
              <div className="series-modal-info">
                <div className="series-modal-title">{seriesDetail.item.name}</div>
                <div className="series-modal-meta">
                  {[seriesDetail.item.year, seriesDetail.item.rating && `★${parseFloat(seriesDetail.item.rating||0).toFixed(1)}`].filter(Boolean).join(" · ")}
                  {seriesDetail.seasons.length > 0 && ` · ${seriesDetail.seasons.length} Season${seriesDetail.seasons.length > 1 ? "s" : ""}`}
                </div>
                {seriesDetail.item.description && (
                  <div className="series-modal-desc">{seriesDetail.item.description}</div>
                )}
              </div>
              <button className="series-modal-close" onClick={() => setSeriesDetail(null)} title="Close">✕</button>
            </div>
            {/* Body */}
            <div className="series-modal-body">
              {seriesLoading ? (
                <div className="series-loading">
                  <div className="spinner" />
                  <span>{t("loadingSeasons")}</span>
                </div>
              ) : seriesDetail.seasons.length === 0 ? (
                <div style={{textAlign:"center",padding:"2rem",color:"var(--t2)",fontSize:".85rem"}}>
                  {t("noSeasonsFound")}
                </div>
              ) : (
                <>
                  {/* Season tabs */}
                  {seriesDetail.seasons.length > 1 && (
                    <div className="series-seasons-tabs">
                      {seriesDetail.seasons.map((s, idx) => (
                        <button key={s.id || idx}
                          className={`series-season-tab ${seriesDetail.activeSeason === idx ? "on" : ""}`}
                          onClick={() => setSeriesDetail(prev => ({ ...prev, activeSeason: idx }))}>
                          {s.name || `Season ${idx + 1}`}
                        </button>
                      ))}
                    </div>
                  )}
                  {seriesDetail.seasons.length === 1 && (
                    <div style={{fontSize:".8rem",fontWeight:600,color:"var(--t2)",marginBottom:".7rem"}}>
                      {seriesDetail.seasons[0].name || "Season 1"} — {seriesDetail.seasons[0].episodes.length} episode{seriesDetail.seasons[0].episodes.length !== 1 ? "s" : ""}
                    </div>
                  )}
                  {/* Episode list */}
                  <div className="series-ep-list">
                    {(() => {
                      const season = seriesDetail.seasons[seriesDetail.activeSeason];
                      if (!season) return null;
                      const episodes = toSeriesEpisodeDisplay(season.episodes, conn?.type === "xtream");
                      return episodes.map(ep => (
                        <div key={ep.num}
                          className={`series-ep-item ${episodeLoading === ep.num ? "loading" : ""}`}
                          onClick={() => playSeriesEpisode(season, ep.num)}>
                          <div className="series-ep-num">{ep.num}</div>
                          <div className="series-ep-name">{ep.label}</div>
                          {episodeLoading === ep.num
                            ? <div className="spinner" style={{width:16,height:16,borderWidth:2}} />
                            : <span className="series-ep-play">▶</span>}
                        </div>
                      ));
                    })()}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── CONNECTION MANAGER ── */}
      {showConnManager && (
        <ConnectionManager
          connections={connections}
          activeConnId={activeConnId}
          onSwitch={switchConnection}
          onRemove={removeConnection}
          onAddNew={addNewConnection}
          onEdit={setEditingConn}
          onClose={() => setShowConnManager(false)}
          authUser={authUser}
          isGuest={isGuest}
          onLogout={handleLogout}
          t={t}
        />
      )}

      {editingConn && (
        <EditConnectionModal
          conn={editingConn}
          onClose={() => setEditingConn(null)}
          onSave={handleEditConnection}
          t={t}
        />
      )}

      {/* ── CATEGORY EDITOR MODAL ── */}
      {showCatEditor && (() => {
        const editSec = showCatEditor;
        const editCats = editSec === "live" ? (["All", ...new Set(channels.map(i=>i.group).filter(Boolean))]) 
                       : editSec === "vod" ? (conn?.type === "stalker" ? stalkerVodCats.map(c=>c.title) : ["All", ...new Set(vod.map(i=>i.group).filter(Boolean))])
                       : editSec === "series" ? (conn?.type === "stalker" ? stalkerSeriesCats.map(c=>c.title) : ["All", ...new Set(series.map(i=>i.group).filter(Boolean))])
                       : [];
        return (
          <div style={{position:"fixed",inset:0,zIndex:99999,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}
               onClick={e => { if (e.target === e.currentTarget) setShowCatEditor(null); }}>
            <div style={{background:"var(--card, #0f0f1c)",border:"1px solid var(--border, rgba(255,255,255,0.08))",borderRadius:14,padding:"1.8rem",width:"100%",maxWidth:460,boxShadow:"0 12px 48px rgba(0,0,0,0.6)", maxHeight:"80vh", display:"flex", flexDirection:"column"}}>
              <div style={{fontSize:"1.3rem",fontWeight:700,marginBottom:"1.2rem",color:"var(--t1)",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span>{t("editCategories") || "Edit Categories"}</span>
                <span style={{fontSize:".8rem",fontWeight:400,color:"var(--t3)",textTransform:"uppercase"}}>{LABEL[editSec]}</span>
              </div>
              <div style={{flex:1, overflowY:"auto", marginBottom:"1.5rem", display:"flex", flexDirection:"column", gap:".7rem", paddingRight:".5rem"}}>
                {editCats.filter(c => c !== "All").map(c => {
                   const hidden = isCatHidden(editSec, c);
                   return (
                     <label key={c} style={{display:"flex", alignItems:"center", gap:".8rem", cursor:"pointer", color:"var(--t1)", fontSize:".98rem", background:"rgba(255,255,255,0.03)", padding:".7rem .9rem", borderRadius:8, border:"1px solid var(--border)"}}>
                       <input type="checkbox" checked={!hidden} onChange={() => toggleHideCat(editSec, c)} style={{cursor:"pointer", width:20, height:20}} />
                       <span style={{flex:1}}>{c}</span>
                     </label>
                   );
                })}
              </div>
              <button onClick={() => setShowCatEditor(null)} className="btn-go" style={{width:"100%", padding:"1rem"}}>Done</button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// SUB-VIEWS
// ══════════════════════════════════════════════════════════════════
const FavsView = memo(function FavsView({ favItems, onPlay, toggleFav, t }) {
  const all = [...favItems.live, ...favItems.vod, ...favItems.series];
  if (!all.length) return (
    <div className="empty">
      <div className="empty-icon">♡</div>
      <div className="empty-t">{t("noFavsYet")}</div>
      <div className="empty-s">{t("favHint")}</div>
    </div>
  );
  const groups = [[t("liveTV"), favItems.live], [t("movies"), favItems.vod], [t("series"), favItems.series]];
  return (
    <div style={{flex:1,overflow:"auto",padding:"1.1rem 1.4rem",display:"flex",flexDirection:"column",gap:"1.5rem"}}>
      {groups.filter(([,items]) => items.length > 0).map(([label, items]) => (
        <div key={label} className="section-block">
          <div className="section-label">{label}</div>
          <div className={label==="Live TV" ? "ch-grid" : "vod-grid"}>
            {items.map((item,i) => label==="Live TV" ? (
              <div key={item.id||i} className="ch-card" onClick={() => onPlay(item)}>
                {item.logo ? <img className="ch-logo" loading="lazy" src={imgSrc(item.logo)} alt="" /> : <div className="ch-logo-ph">📺</div>}
                <div className="ch-name">{item.name}</div>
                <FavBtn on={true} onClick={() => toggleFav(item)} />
              </div>
            ) : (
              <div key={item.id||i} className="vod-card" onClick={() => onPlay(item)}>
                {item.logo ? <img className="vod-poster" loading="lazy" src={imgSrc(item.logo)} alt="" /> : <div className="vod-ph">🎬</div>}
                <div className="vod-info"><div className="vod-title">{item.name}</div></div>
                <button className="vod-fav on" onClick={e=>{e.stopPropagation();toggleFav(item);}}>♥</button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
});

const ContinueView = memo(function ContinueView({ items, onPlay, history, t }) {
  const recent = history.slice(0, 20);
  if (!recent.length) return (
    <div className="empty">
      <div className="empty-icon">⏯</div>
      <div className="empty-t">{t("nothingStarted")}</div>
      <div className="empty-s">{t("resumeHint")}</div>
    </div>
  );
  return (
    <div style={{flex:1,overflow:"auto",padding:"1.1rem 1.4rem",display:"flex",flexDirection:"column",gap:"1.5rem"}}>
      {items.length > 0 && (
        <div className="section-block">
          <div className="section-label">{t("resumeWatching")}</div>
          <div className="cw-row">
            {items.map((item,i) => {
              const pct = item.duration ? Math.min(100,(item.position/item.duration)*100) : 0;
              return (
                <div key={item.id||i} className="cw-item" onClick={()=>onPlay(item)}>
                  {item.logo ? <img className="cw-poster" loading="lazy" src={imgSrc(item.logo)} alt="" style={{width:"100%",aspectRatio:"16/9",objectFit:"cover"}} /> : <div className="cw-poster">🎬</div>}
                  <div className="cw-prog-bar"><div className="cw-prog-fill" style={{width:`${pct}%`}} /></div>
                  <div className="cw-info">
                    <div className="cw-name">{item.name}</div>
                    <div className="cw-time">{fmtTime(item.position)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="section-block">
        <div className="section-label">{t("recentlyWatched")}</div>
        <div style={{display:"flex",flexDirection:"column",gap:".4rem"}}>
          {recent.map((item,i) => (
            <div key={item.id||i} style={{display:"flex",alignItems:"center",gap:".75rem",padding:".5rem .75rem",
              background:"var(--s1)",border:"1px solid var(--b1)",borderRadius:"9px",cursor:"pointer",transition:"all .2s"}}
              onClick={()=>onPlay(item)}
              onMouseEnter={e=>e.currentTarget.style.borderColor="var(--b2)"}
              onMouseLeave={e=>e.currentTarget.style.borderColor="var(--b1)"}>
              {item.logo ? <img loading="lazy" style={{width:"30px",height:"30px",objectFit:"contain",borderRadius:"4px",background:"var(--s2)",flexShrink:0}} src={imgSrc(item.logo)} alt="" /> : <div style={{width:"30px",height:"30px",background:"var(--s2)",borderRadius:"4px",display:"flex",alignItems:"center",justifyContent:"center",fontSize:".75rem",flexShrink:0}}>{item.type==="live"?"📺":"🎬"}</div>}
              <div style={{flex:1,overflow:"hidden"}}>
                <div style={{fontSize:".8rem",fontWeight:500,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.name}</div>
                <div style={{fontSize:".65rem",color:"var(--t3)"}}>{item.group} · {new Date(item.timestamp).toLocaleDateString()}</div>
              </div>
              <div style={{fontSize:".65rem",color:"var(--t3)",textTransform:"capitalize",flexShrink:0}}>{item.type}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});

const GlobalSearch = memo(function GlobalSearch({ results, query, onPlay, toggleFav, isFav, t, limited = false }) {
  if (!query || query.length < 2) return (
    <div className="empty">
      <div className="empty-icon">🔍</div>
      <div className="empty-t">{t("searchEverything")}</div>
      <div className="empty-s">{t("searchHint")}</div>
    </div>
  );
  if (!results.length && limited) return (
    <div className="empty">
      <div className="empty-icon">?</div>
      <div className="empty-t">{t("noResults", query)}</div>
      <div className="empty-s">Provider search is unavailable or not verified yet; results cover loaded content only.</div>
    </div>
  );
  if (!results.length) return (
    <div className="empty"><div className="empty-icon">🔍</div><div className="empty-t">{t("noResults", query)}</div></div>
  );
  const byType = { live:results.filter(r=>r.type==="live"), vod:results.filter(r=>r.type==="vod"), series:results.filter(r=>r.type==="series") };
  const ICONS = {live:"📺",vod:"🎬",series:"📽"};
  const LABELS = {live:t("liveTV"),vod:t("movies"),series:t("series")};
  return (
    <div className="gsearch">
      {Object.entries(byType).filter(([,items])=>items.length).map(([type,items]) => (
        <div key={type} className="gsearch-section">
          <div className="section-label">{LABELS[type]} <span style={{fontFamily:"'DM Sans'",fontWeight:400,color:"var(--t3)",textTransform:"none",letterSpacing:0}}>({items.length})</span></div>
          {items.map((item,i) => (
            <div key={item.id||i} className="gsearch-row" onClick={()=>onPlay(item)}>
              {item.logo ? <img className="gsearch-logo" loading="lazy" src={imgSrc(item.logo)} alt="" onError={e=>e.target.style.display="none"} /> : <div className="gsearch-logo-ph">{ICONS[type]}</div>}
              <div className="gsearch-name">{item.name}</div>
              <div className="gsearch-group">{item.group}</div>
              <button style={{background:"none",border:"none",cursor:"pointer",fontSize:".9rem",color:isFav(item)?"var(--accent)":"var(--t3)",padding:".1rem .2rem",transition:"color .2s"}}
                onClick={e=>{e.stopPropagation();toggleFav(item);}}>
                {isFav(item)?"♥":"♡"}
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
});



const EPGView = memo(function EPGView({ channels, epgData, epgURL, epgSources, activeEpgSource, setActiveEpgSource, epgLoading, loadEPG, onPlay, onPlayCatchup, showCatchup, t }) {
  const PX_PER_MIN = 3;
  const CH_COL_W = 160;
  const MAX_CHANNELS = 200;

  const [urlInput, setUrlInput] = useState(epgURL || "");
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const outerRef = useRef(null);

  // Auto-scroll to "now" on mount
  useEffect(() => {
    trackAnalytics("epg_interaction", { action: "open", screen: "tvGuide", provider_type: "unknown" });
    if (outerRef.current && epgData) {
      const nowOffset = 60 * PX_PER_MIN; // 1 hour in = 180px
      const viewW = outerRef.current.clientWidth;
      outerRef.current.scrollLeft = Math.max(0, CH_COL_W + nowOffset - viewW / 3);
    }
  }, [epgData]);

  // Track searches inside EPG
  useEffect(() => {
    if (search.length > 0) {
      const timer = setTimeout(() => {
        trackAnalytics("epg_interaction", { action: "filter", screen: "tvGuide", provider_type: "unknown" });
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [search]);

  const filteredChannels = useMemo(() => {
    let chs = channels;
    if (deferredSearch) { const q = deferredSearch.toLowerCase(); chs = chs.filter(ch => ch.name?.toLowerCase().includes(q)); }
    return chs.slice(0, MAX_CHANNELS);
  }, [channels, deferredSearch]);

  const handleNow = useCallback(() => {
    setTimeout(() => {
      if (!outerRef.current) return;
      const nowOffset = 60 * PX_PER_MIN;
      const viewW = outerRef.current.clientWidth;
      outerRef.current.scrollTo({ left: Math.max(0, CH_COL_W + nowOffset - viewW / 3), behavior: "smooth" });
    }, 50);
  }, []);

  const handleShift = useCallback((deltaMs) => {
    if (!outerRef.current) return;
    outerRef.current.scrollBy({ left: (deltaMs / 60000) * PX_PER_MIN, behavior: "smooth" });
  }, []);

  return (
    <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>
      {/* EPG URL bar */}
      <div className="epg-top">
        <input className="fi" style={{flex:"1 1 260px",minWidth:0}} placeholder="XMLTV EPG URL (e.g. http://provider.com/epg.xml)"
          value={urlInput} onChange={e=>setUrlInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&loadEPG(urlInput)} />
        <button className="btn-go" onClick={()=>loadEPG(urlInput)} disabled={epgLoading} style={{padding:".4rem .9rem",fontSize:".82rem"}}>
          {epgLoading ? t("loading") : t("loadEPG")}
        </button>

        {epgSources.length > 0 && (
          <select className="fi" style={{width:160}} value={activeEpgSource} onChange={e=>setActiveEpgSource(e.target.value)}>
            <option value="all">All</option>
            {epgSources.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        )}

        {channels.length > 0 && (
          <input className="fi" style={{width:"160px"}} placeholder="Filter channels\u2026"
            value={search} onChange={e=>setSearch(e.target.value)} />
        )}
      </div>

      {/* Empty states */}
      {!channels.length ? (
        <div className="empty"><div className="empty-icon">📋</div><div className="empty-t">No channels loaded</div><div className="empty-s">Connect via Xtream Codes or M3U to populate TV Guide.</div></div>
      ) : !epgData ? (
        <div className="empty">
          <div className="empty-icon">📅</div>
          <div className="empty-t">No EPG data</div>
          <div className="empty-s">Paste your XMLTV EPG URL above and click Load EPG.<br/>Your provider may supply one — check their portal or dashboard.</div>
        </div>
      ) : (
        <>
          {/* Scrollable grid */}
          <TimelineGrid
            key={activeEpgSource}
            ref={outerRef}
            channels={filteredChannels}
            epgData={epgData}
            onPlay={onPlay}            onPlayCatchup={onPlayCatchup}
            showCatchup={showCatchup}
          />

          {/* Navigation bar */}
          <div className="epg-nav">
            <button onClick={()=>handleShift(-7200000)}>{"\u2190"} 2hr</button>
            <button className="epg-nav-now" onClick={handleNow}>Now</button>
            <button onClick={()=>handleShift(7200000)}>2hr {"\u2192"}</button>
          </div>
        </>
      )}
    </div>
  );
});

// DirectHLSView moved to src/components/DirectHLSView.jsx
// DiscoverView moved to src/components/DiscoverView.jsx
