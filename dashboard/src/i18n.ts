import { createContext, useContext } from 'react'

export type Locale = 'en' | 'ru'

const translations = {
  en: {
    // Layout
    'nav.overview': 'Overview',
    'nav.sessions': 'Sessions',
    'nav.stats': 'Stats',
    'nav.logs': 'Logs',
    'nav.memory': 'Memory',
    'layout.logout': 'Logout',

    // Login
    'login.title': 'Helyx Dashboard',
    'login.subtitle': 'Login with your Telegram account',
    'login.error': 'Authorization failed',
    'login.notice': 'Only authorized users can access this dashboard',

    // Overview
    'overview.title': 'Overview',
    'overview.uptime': 'Uptime',
    'overview.database': 'Database',
    'overview.transport': 'Transport',
    'overview.sessions': 'Sessions',
    'overview.last24h': 'Last 24 hours',
    'overview.requests': 'Requests',
    'overview.inputTokens': 'Input Tokens',
    'overview.outputTokens': 'Output Tokens',
    'overview.totalTokens': 'Total Tokens',
    'overview.recentSessions': 'Recent Sessions',
    'overview.connected': 'Connected',
    'overview.disconnected': 'Disconnected',
    'overview.noSessions': 'No sessions',

    // Sessions
    'sessions.title': 'Sessions',
    'sessions.refresh': 'Refresh',
    'sessions.id': 'ID',
    'sessions.name': 'Name',
    'sessions.project': 'Project',
    'sessions.status': 'Status',
    'sessions.lastActive': 'Last Active',
    'sessions.connectedAt': 'Connected',
    'sessions.noSessions': 'No sessions',
    'sessions.active': 'active',
    'sessions.disconnected': 'disconnected',

    // Session Detail
    'session.back': 'Back',
    'session.edit': 'edit',
    'session.save': 'Save',
    'session.cancel': 'Cancel',
    'session.delete': 'Delete Session',
    'session.deleteConfirm': 'Delete session "{name}" and all its data?',
    'session.messages': 'Messages',
    'session.messageCount': 'Messages',
    'session.notFound': 'Session not found',
    'session.previous': 'Previous',
    'session.next': 'Next',
    'session.user': 'user',
    'session.assistant': 'assistant',
    'session.noMessages': 'No messages',

    // Stats
    'stats.title': 'Stats',
    'stats.totalRequests': 'Requests',
    'stats.totalTokens': 'Total Tokens',
    'stats.avgLatency': 'Avg Latency',
    'stats.successRate': 'Success Rate',
    'stats.errors': 'errors',
    'stats.tokensChart': 'Tokens (last 30 days)',
    'stats.byProvider': 'By Provider',
    'stats.bySession': 'By Session',
    'stats.provider': 'Provider',
    'stats.model': 'Model',
    'stats.tokens': 'Tokens',
    'stats.byProject': 'By Project',
    'stats.byOperation': 'By Operation',
    'stats.project': 'Project',
    'stats.operation': 'Operation',
    'stats.cost': 'Cost',
    'stats.sessions': 'Sessions',
    'stats.inputTokens': 'Input',
    'stats.outputTokens': 'Output',
    'stats.transcription': 'Transcription',
    'stats.total': 'Total',
    'stats.success': 'Success',
    'stats.in': 'in',
    'stats.out': 'out',

    // Logs
    'logs.title': 'Logs',
    'logs.allSessions': 'All sessions',
    'logs.allLevels': 'All levels',
    'logs.search': 'Search...',
    'logs.time': 'Time',
    'logs.session': 'Session',
    'logs.level': 'Level',
    'logs.stage': 'Stage',
    'logs.message': 'Message',
    'logs.noLogs': 'No logs',
    'logs.of': 'of',

    // Memory
    'memory.title': 'Memory',
    'memory.allTypes': 'All types',
    'memory.search': 'Search...',
    'memory.content': 'Content',
    'memory.type': 'Type',
    'memory.tags': 'Tags',
    'memory.project': 'Project',
    'memory.created': 'Created',
    'memory.deleteBtn': 'Delete',
    'memory.deleteConfirm': 'Delete this memory?',
    'memory.noMemories': 'No memories',

    // Projects
    'nav.projects': 'Projects',
    'projects.title': 'Projects',
    'projects.name': 'Name',
    'projects.path': 'Path',
    'projects.status': 'Status',
    'projects.actions': 'Actions',
    'projects.active': 'Active',
    'projects.inactive': 'Inactive',
    'projects.start': 'Start',
    'projects.stop': 'Stop',
    'projects.delete': 'Delete',
    'projects.deleteConfirm': 'Delete project "{name}"?',
    'projects.noProjects': 'No projects',
    'projects.addTitle': 'Add Project',
    'projects.namePlaceholder': 'Project name',
    'projects.pathPlaceholder': '/absolute/path/to/project',
    'projects.addBtn': 'Add',
    'projects.adding': 'Adding...',

    // Monitor
    'nav.monitor': 'Monitor',
    'nav.agents': 'Agents',
    'nav.tasks': 'Tasks',
    'nav.models': 'Models',

    // Permissions
    'nav.permissions': 'Permissions',
    'permissions.title': 'Pending Permissions',
    'permissions.empty': 'No pending permissions',
    'permissions.tool': 'Tool',
    'permissions.description': 'Description',
    'permissions.session': 'Session',
    'permissions.age': 'Age',
    'permissions.allow': 'Allow',
    'permissions.always': 'Always',
    'permissions.deny': 'Deny',

    // Common
    'common.loading': 'Loading...',
    'common.error': 'Error',
    'common.previous': 'Previous',
    'common.next': 'Next',
    'common.refresh': 'Refresh',
    'common.justNow': 'just now',
    'common.mAgo': '{n}m ago',
    'common.hAgo': '{n}h ago',
    'common.dAgo': '{n}d ago',
  },
  ru: {
    // Layout
    'nav.overview': 'Обзор',
    'nav.sessions': 'Сессии',
    'nav.stats': 'Статистика',
    'nav.logs': 'Логи',
    'nav.memory': 'Память',
    'layout.logout': 'Выйти',

    // Login
    'login.title': 'Helyx Dashboard',
    'login.subtitle': 'Войдите через Telegram',
    'login.error': 'Ошибка авторизации',
    'login.notice': 'Доступ только для авторизованных пользователей',

    // Overview
    'overview.title': 'Обзор',
    'overview.uptime': 'Аптайм',
    'overview.database': 'База данных',
    'overview.transport': 'Транспорт',
    'overview.sessions': 'Сессии',
    'overview.last24h': 'Последние 24 часа',
    'overview.requests': 'Запросы',
    'overview.inputTokens': 'Входные токены',
    'overview.outputTokens': 'Выходные токены',
    'overview.totalTokens': 'Всего токенов',
    'overview.recentSessions': 'Последние сессии',
    'overview.connected': 'Подключена',
    'overview.disconnected': 'Отключена',
    'overview.noSessions': 'Нет сессий',

    // Sessions
    'sessions.title': 'Сессии',
    'sessions.refresh': 'Обновить',
    'sessions.id': 'ID',
    'sessions.name': 'Имя',
    'sessions.project': 'Проект',
    'sessions.status': 'Статус',
    'sessions.lastActive': 'Активность',
    'sessions.connectedAt': 'Подключена',
    'sessions.noSessions': 'Нет сессий',
    'sessions.active': 'активна',
    'sessions.disconnected': 'отключена',

    // Session Detail
    'session.back': 'Назад',
    'session.edit': 'изменить',
    'session.save': 'Сохранить',
    'session.cancel': 'Отмена',
    'session.delete': 'Удалить сессию',
    'session.deleteConfirm': 'Удалить сессию "{name}" и все её данные?',
    'session.messages': 'Сообщения',
    'session.messageCount': 'Сообщений',
    'session.notFound': 'Сессия не найдена',
    'session.previous': 'Назад',
    'session.next': 'Далее',
    'session.user': 'пользователь',
    'session.assistant': 'ассистент',
    'session.noMessages': 'Нет сообщений',

    // Stats
    'stats.title': 'Статистика',
    'stats.totalRequests': 'Запросы',
    'stats.totalTokens': 'Всего токенов',
    'stats.avgLatency': 'Ср. задержка',
    'stats.successRate': 'Успешность',
    'stats.errors': 'ошибок',
    'stats.tokensChart': 'Токены (30 дней)',
    'stats.byProvider': 'По провайдерам',
    'stats.bySession': 'По сессиям',
    'stats.provider': 'Провайдер',
    'stats.model': 'Модель',
    'stats.tokens': 'Токены',
    'stats.byProject': 'По проектам',
    'stats.byOperation': 'По операциям',
    'stats.project': 'Проект',
    'stats.operation': 'Операция',
    'stats.cost': 'Стоимость',
    'stats.sessions': 'Сессии',
    'stats.inputTokens': 'Вход',
    'stats.outputTokens': 'Выход',
    'stats.transcription': 'Транскрипция',
    'stats.total': 'Всего',
    'stats.success': 'Успешно',
    'stats.in': 'вход',
    'stats.out': 'выход',

    // Logs
    'logs.title': 'Логи',
    'logs.allSessions': 'Все сессии',
    'logs.allLevels': 'Все уровни',
    'logs.search': 'Поиск...',
    'logs.time': 'Время',
    'logs.session': 'Сессия',
    'logs.level': 'Уровень',
    'logs.stage': 'Этап',
    'logs.message': 'Сообщение',
    'logs.noLogs': 'Нет логов',
    'logs.of': 'из',

    // Memory
    'memory.title': 'Память',
    'memory.allTypes': 'Все типы',
    'memory.search': 'Поиск...',
    'memory.content': 'Содержание',
    'memory.type': 'Тип',
    'memory.tags': 'Теги',
    'memory.project': 'Проект',
    'memory.created': 'Создано',
    'memory.deleteBtn': 'Удалить',
    'memory.deleteConfirm': 'Удалить это воспоминание?',
    'memory.noMemories': 'Нет воспоминаний',

    // Projects
    'nav.projects': 'Проекты',
    'projects.title': 'Проекты',
    'projects.name': 'Название',
    'projects.path': 'Путь',
    'projects.status': 'Статус',
    'projects.actions': 'Действия',
    'projects.active': 'Активен',
    'projects.inactive': 'Неактивен',
    'projects.start': 'Запустить',
    'projects.stop': 'Остановить',
    'projects.delete': 'Удалить',
    'projects.deleteConfirm': 'Удалить проект "{name}"?',
    'projects.noProjects': 'Нет проектов',
    'projects.addTitle': 'Добавить проект',
    'projects.namePlaceholder': 'Название проекта',
    'projects.pathPlaceholder': '/абсолютный/путь/к/проекту',
    'projects.addBtn': 'Добавить',
    'projects.adding': 'Добавление...',

    // Monitor
    'nav.monitor': 'Мониторинг',
    'nav.agents': 'Агенты',
    'nav.tasks': 'Задачи',
    'nav.models': 'Модели',

    // Permissions
    'nav.permissions': 'Разрешения',
    'permissions.title': 'Ожидающие разрешения',
    'permissions.empty': 'Нет ожидающих запросов',
    'permissions.tool': 'Инструмент',
    'permissions.description': 'Описание',
    'permissions.session': 'Сессия',
    'permissions.age': 'Время',
    'permissions.allow': 'Разрешить',
    'permissions.always': 'Всегда',
    'permissions.deny': 'Отклонить',

    // Common
    'common.loading': 'Загрузка...',
    'common.error': 'Ошибка',
    'common.previous': 'Назад',
    'common.next': 'Далее',
    'common.refresh': 'Обновить',
    'common.justNow': 'только что',
    'common.mAgo': '{n} мин назад',
    'common.hAgo': '{n}ч назад',
    'common.dAgo': '{n}д назад',
  },
} as const

type TranslationKey = keyof typeof translations.en

function getStoredLocale(): Locale {
  try {
    const stored = localStorage.getItem('locale')
    if (stored === 'en' || stored === 'ru') return stored
  } catch {}
  // Auto-detect from browser
  const lang = navigator.language.toLowerCase()
  return lang.startsWith('ru') ? 'ru' : 'en'
}

export interface I18nContextType {
  locale: Locale
  setLocale: (l: Locale) => void
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
}

export const I18nContext = createContext<I18nContextType>(null!)

export function createI18n(locale: Locale): Omit<I18nContextType, 'setLocale'> {
  const t = (key: TranslationKey, params?: Record<string, string | number>): string => {
    let str: string = translations[locale]?.[key] ?? translations.en[key] ?? key
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(`{${k}}`, String(v))
      }
    }
    return str
  }
  return { locale, t }
}

export function useI18n(): I18nContextType {
  return useContext(I18nContext)
}

export { getStoredLocale }
