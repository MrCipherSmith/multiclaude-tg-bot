import { Outlet, Link, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import {
  LayoutDashboard, Monitor, BarChart3, ScrollText, BookOpen, FolderOpen,
  PanelLeftClose, PanelLeft, LogOut, Languages, ChevronDown, Bot, ShieldAlert, Activity,
  Cpu, ListChecks, Boxes,
} from 'lucide-react'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { cn } from '../lib/utils'
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator, DropdownMenuLabel,
} from '../components/ui/dropdown-menu'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '../components/ui/tooltip'
import { ErrorBoundary } from '../components/ErrorBoundary'

export function Layout() {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const router = useRouterState()
  const pathname = router.location.pathname
  const { t, locale, setLocale } = useI18n()

  const { data: pendingPerms } = useQuery({
    queryKey: ['permissions-pending'],
    queryFn: () => api.pendingPermissions(),
    refetchInterval: 5_000,
  })
  const pendingCount = pendingPerms?.length ?? 0

  const NAV_ITEMS = [
    { to: '/', label: t('nav.overview'), icon: LayoutDashboard },
    { to: '/sessions', label: t('nav.sessions'), icon: Monitor },
    { to: '/projects', label: t('nav.projects'), icon: FolderOpen },
    { to: '/agents', label: t('nav.agents'), icon: Cpu },
    { to: '/tasks', label: t('nav.tasks'), icon: ListChecks },
    { to: '/models', label: t('nav.models'), icon: Boxes },
    { to: '/permissions', label: t('nav.permissions'), icon: ShieldAlert, badge: pendingCount },
    { to: '/monitor', label: t('nav.monitor'), icon: Activity },
    { to: '/stats', label: t('nav.stats'), icon: BarChart3 },
    { to: '/logs', label: t('nav.logs'), icon: ScrollText },
    { to: '/memories', label: t('nav.memory'), icon: BookOpen },
  ] as const

  const { data: user } = useQuery({ queryKey: ['auth-me'], queryFn: api.authMe })

  const handleLogout = async () => {
    await api.logout()
    window.location.href = '/login'
  }

  const toggleLocale = () => setLocale(locale === 'en' ? 'ru' : 'en')

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen overflow-hidden bg-gray-950">
        {/* Mobile overlay */}
        {mobileOpen && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-20 lg:hidden" onClick={() => setMobileOpen(false)} />
        )}

        {/* Sidebar */}
        <aside className={cn(
          "fixed lg:static inset-y-0 left-0 z-30 flex flex-col bg-gray-900/80 backdrop-blur-xl border-r border-gray-800/50 transition-all duration-200",
          collapsed ? "w-16" : "w-60",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}>
          {/* Logo + collapse */}
          <div className={cn("h-16 flex items-center border-b border-gray-800/50 shrink-0", collapsed ? "justify-center px-2" : "justify-between px-4")}>
            {!collapsed && (
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/25">
                  <Bot className="w-4 h-4 text-white" />
                </div>
                <span className="text-base font-semibold text-white tracking-tight">Helyx</span>
              </div>
            )}
            <button
              onClick={() => setCollapsed(!collapsed)}
              className="hidden lg:flex p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-white/5 transition-colors"
            >
              {collapsed ? <PanelLeft className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
            </button>
            {collapsed && (
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/25 lg:hidden">
                <Bot className="w-4 h-4 text-white" />
              </div>
            )}
          </div>

          {/* Navigation */}
          <nav className={cn("flex-1 py-3 space-y-0.5", collapsed ? "px-2" : "px-3")}>
            {NAV_ITEMS.map((item) => {
              const isActive = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to)
              const Icon = item.icon
              const badge = 'badge' in item ? (item as any).badge : 0
              const link = (
                <Link
                  key={item.to}
                  to={item.to}
                  onClick={() => setMobileOpen(false)}
                  className={cn(
                    "flex items-center rounded-lg text-sm font-medium transition-all",
                    collapsed ? "justify-center p-2.5" : "gap-3 px-3 py-2.5",
                    isActive
                      ? "bg-indigo-500/10 text-white border-l-2 border-indigo-500"
                      : "text-gray-400 hover:text-white hover:bg-white/5 border-l-2 border-transparent"
                  )}
                >
                  <span className="relative shrink-0">
                    <Icon className={cn("w-[18px] h-[18px]", isActive ? "text-indigo-400" : "text-gray-500")} />
                    {badge > 0 && (
                      <span className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 rounded-full bg-amber-500 flex items-center justify-center text-[9px] font-bold text-white leading-none">
                        {badge > 9 ? '9+' : badge}
                      </span>
                    )}
                  </span>
                  {!collapsed && <span className="flex-1">{item.label}</span>}
                  {!collapsed && badge > 0 && (
                    <span className="ml-auto px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 text-xs font-semibold">
                      {badge}
                    </span>
                  )}
                </Link>
              )

              if (collapsed) {
                return (
                  <Tooltip key={item.to}>
                    <TooltipTrigger asChild>{link}</TooltipTrigger>
                    <TooltipContent side="right">{item.label}</TooltipContent>
                  </Tooltip>
                )
              }
              return link
            })}
          </nav>

          {/* User footer */}
          <div className={cn("border-t border-gray-800/50 shrink-0", collapsed ? "p-2" : "p-3")}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className={cn(
                  "w-full flex items-center rounded-lg transition-colors hover:bg-white/5",
                  collapsed ? "justify-center p-2" : "gap-3 px-3 py-2.5"
                )}>
                  {user?.photo_url ? (
                    <img src={user.photo_url} alt="" className="w-8 h-8 rounded-full ring-2 ring-gray-700 shrink-0" />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-violet-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
                      {user?.first_name?.[0] || '?'}
                    </div>
                  )}
                  {!collapsed && user && (
                    <>
                      <div className="flex-1 min-w-0 text-left">
                        <div className="text-sm font-medium text-white truncate">{user.first_name}</div>
                        {user.username && <div className="text-xs text-gray-500 truncate">@{user.username}</div>}
                      </div>
                      <ChevronDown className="w-4 h-4 text-gray-500 shrink-0" />
                    </>
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side={collapsed ? "right" : "top"} align="start" className="w-48">
                {user && (
                  <>
                    <DropdownMenuLabel>{user.first_name}{user.username ? ` (@${user.username})` : ''}</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem onClick={toggleLocale}>
                  <Languages className="w-4 h-4" />
                  {locale === 'en' ? 'Русский' : 'English'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleLogout} className="text-red-400 hover:!text-red-300">
                  <LogOut className="w-4 h-4" />
                  {t('layout.logout')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </aside>

        {/* Main */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Mobile header */}
          <header className="h-14 lg:hidden bg-gray-900/50 backdrop-blur-xl border-b border-gray-800/50 flex items-center px-4 shrink-0">
            <button className="text-gray-400 hover:text-white p-2 -ml-2 rounded-lg hover:bg-white/5" onClick={() => setMobileOpen(true)}>
              <PanelLeft className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 ml-3">
              <Bot className="w-5 h-5 text-indigo-400" />
              <span className="text-sm font-semibold text-white">Helyx</span>
            </div>
          </header>

          {/* Page — ErrorBoundary scoped to the routed content keeps the
              sidebar + header intact when a single page component throws
              (malformed API response, unexpected null in a deep chain, etc.) */}
          <main className="flex-1 overflow-auto p-6 bg-gradient-subtle">
            <div className="max-w-7xl mx-auto animate-in">
              <ErrorBoundary>
                <Outlet />
              </ErrorBoundary>
            </div>
          </main>
        </div>
      </div>
    </TooltipProvider>
  )
}
