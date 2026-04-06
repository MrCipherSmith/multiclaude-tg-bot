import { StrictMode, useState, useCallback } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createRouter, createRootRoute, createRoute, Outlet, redirect } from '@tanstack/react-router'
import { I18nContext, createI18n, getStoredLocale, type Locale } from './i18n'
import { api } from './api/client'
import './index.css'

// Pages
import { LoginPage } from './pages/Login'
import { Layout } from './pages/Layout'
import { OverviewPage } from './pages/Overview'
import { SessionsPage } from './pages/Sessions'
import { SessionDetailPage } from './pages/SessionDetail'
import { StatsPage } from './pages/Stats'
import { LogsPage } from './pages/Logs'
import { MemoriesPage } from './pages/Memories'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
})

// Auth check
async function requireAuth() {
  try {
    await api.authMe()
  } catch {
    throw redirect({ to: '/login' })
  }
}

// Routes
const rootRoute = createRootRoute({ component: () => <Outlet /> })

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
})

const layoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authenticated',
  component: Layout,
  beforeLoad: requireAuth,
})

const overviewRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/',
  component: OverviewPage,
})

const sessionsRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/sessions',
  component: SessionsPage,
})

const sessionDetailRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/sessions/$id',
  component: SessionDetailPage,
})

const statsRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/stats',
  component: StatsPage,
})

const logsRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/logs',
  component: LogsPage,
})

const memoriesRoute = createRoute({
  getParentRoute: () => layoutRoute,
  path: '/memories',
  component: MemoriesPage,
})

const routeTree = rootRoute.addChildren([
  loginRoute,
  layoutRoute.addChildren([
    overviewRoute,
    sessionsRoute,
    sessionDetailRoute,
    statsRoute,
    logsRoute,
    memoriesRoute,
  ]),
])

const router = createRouter({ routeTree })

function App() {
  const [locale, setLocaleState] = useState<Locale>(getStoredLocale())

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l)
    localStorage.setItem('locale', l)
  }, [])

  const i18n = { ...createI18n(locale), setLocale }

  return (
    <StrictMode>
      <I18nContext.Provider value={i18n}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </I18nContext.Provider>
    </StrictMode>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
