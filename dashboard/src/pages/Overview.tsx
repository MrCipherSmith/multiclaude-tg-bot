import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect } from 'react'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { useEventStream } from '../hooks/useEventStream'
import { requestNotificationPermission, sendBrowserNotification } from '../lib/notifications'

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const parts = []
  if (d > 0) parts.push(`${d}d`)
  if (h > 0) parts.push(`${h}h`)
  parts.push(`${m}m`)
  return parts.join(' ')
}

const fmt = new Intl.NumberFormat()

export function OverviewPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  // Request notification permission on mount
  useEffect(() => {
    requestNotificationPermission()
  }, [])

  // Subscribe to SSE events for real-time session state updates
  useEventStream("/api/events", {
    "session-state": (data: any) => {
      const statusLabel = data.status === "active" ? "started" : data.status === "inactive" ? "stopped" : data.status
      sendBrowserNotification(
        `Session ${data.project ?? `#${data.id}`} ${statusLabel}`,
        { body: `Status changed to ${data.status}` },
      )
      queryClient.invalidateQueries({ queryKey: ["overview"] })
    },
  })

  const formatRelative = (date: string): string => {
    const diff = (Date.now() - new Date(date).getTime()) / 1000
    if (diff < 60) return t('common.justNow')
    if (diff < 3600) return t('common.mAgo', { n: Math.floor(diff / 60) })
    if (diff < 86400) return t('common.hAgo', { n: Math.floor(diff / 3600) })
    return t('common.dAgo', { n: Math.floor(diff / 86400) })
  }

  const { data, isLoading, error } = useQuery({
    queryKey: ['overview'],
    queryFn: api.overview,
    refetchInterval: 30_000,
  })

  if (isLoading) return <div className="text-gray-400">{t('common.loading')}</div>
  if (error) return <div className="text-red-400">{t('common.error')}: {(error as Error).message}</div>
  if (!data) return null

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold text-white">{t('overview.title')}</h1>

      {/* Status cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label={t('overview.uptime')}
          value={formatUptime(data.uptime)}
          icon={<svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clipRule="evenodd"/></svg>}
          color="indigo"
        />
        <StatCard
          label={t('overview.database')}
          value={data.db === 'connected' ? 'OK' : 'Error'}
          icon={<svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5"><path d="M3 12v3c0 1.657 3.134 3 7 3s7-1.343 7-3v-3c0 1.657-3.134 3-7 3s-7-1.343-7-3z"/><path d="M3 7v3c0 1.657 3.134 3 7 3s7-1.343 7-3V7c0 1.657-3.134 3-7 3S3 8.657 3 7z"/><path d="M17 5c0 1.657-3.134 3-7 3S3 6.657 3 5s3.134-3 7-3 7 1.343 7 3z"/></svg>}
          color={data.db === 'connected' ? 'emerald' : 'red'}
        />
        <StatCard
          label={t('overview.transport')}
          value={data.transport}
          icon={<svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5"><path fillRule="evenodd" d="M5.05 3.636a1 1 0 010 1.414 7 7 0 000 9.9 1 1 0 11-1.414 1.414 9 9 0 010-12.728 1 1 0 011.414 0zm9.9 0a1 1 0 011.414 0 9 9 0 010 12.728 1 1 0 11-1.414-1.414 7 7 0 000-9.9 1 1 0 010-1.414zM7.879 6.464a1 1 0 010 1.414 3 3 0 000 4.243 1 1 0 11-1.415 1.414 5 5 0 010-7.07 1 1 0 011.415 0zm4.242 0a1 1 0 011.415 0 5 5 0 010 7.072 1 1 0 01-1.415-1.415 3 3 0 000-4.242 1 1 0 010-1.415zM10 9a1 1 0 011 1v.01a1 1 0 11-2 0V10a1 1 0 011-1z" clipRule="evenodd"/></svg>}
          color="violet"
        />
        <StatCard
          label={t('overview.sessions')}
          value={`${data.sessions.active} / ${data.sessions.total}`}
          icon={<svg viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5"><path d="M13 6a3 3 0 11-6 0 3 3 0 016 0zm5 2a2 2 0 11-4 0 2 2 0 014 0zm-4 7a4 4 0 00-8 0v3h8v-3zm6 3v-3a3.5 3.5 0 00-2.394-3.317A5.005 5.005 0 0120 18zm-12.194-3.317A3.5 3.5 0 000 15v3h4v-3c0-.825.249-1.592.678-2.232l.128-.085z"/></svg>}
          color="amber"
        />
      </div>

      {/* Token summary 24h */}
      <div>
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">{t('overview.last24h')}</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard label={t('overview.requests')} value={fmt.format(data.tokens24h.requests)} />
          <MetricCard label={t('overview.inputTokens')} value={fmt.format(data.tokens24h.input)} />
          <MetricCard label={t('overview.outputTokens')} value={fmt.format(data.tokens24h.output)} />
          <MetricCard label={t('overview.totalTokens')} value={fmt.format(data.tokens24h.total)} accent />
        </div>
      </div>

      {/* Recent sessions */}
      <div>
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">{t('overview.recentSessions')}</h2>
        <div className="bg-gray-900/50 rounded-xl border border-gray-800/50 overflow-hidden backdrop-blur">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800/50">
                <th className="text-left px-5 py-3 font-medium text-gray-500 text-xs uppercase tracking-wider">{t('sessions.name')}</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500 text-xs uppercase tracking-wider">{t('sessions.status')}</th>
                <th className="text-left px-5 py-3 font-medium text-gray-500 text-xs uppercase tracking-wider">{t('sessions.lastActive')}</th>
              </tr>
            </thead>
            <tbody>
              {data.recentSessions.map((s: any) => (
                <tr key={s.id} className="table-row-hover border-b border-gray-800/30 last:border-0">
                  <td className="px-5 py-3">
                    <Link to="/sessions/$id" params={{ id: String(s.id) }} className="text-indigo-400 hover:text-indigo-300 font-medium transition-colors">
                      {s.name || `Session #${s.id}`}
                    </Link>
                  </td>
                  <td className="px-5 py-3"><StatusBadge status={s.status} /></td>
                  <td className="px-5 py-3 text-gray-500">{formatRelative(s.last_active)}</td>
                </tr>
              ))}
              {data.recentSessions.length === 0 && (
                <tr><td colSpan={3} className="px-5 py-10 text-center text-gray-600">{t('overview.noSessions')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

const COLORS: Record<string, { bg: string; icon: string; glow: string }> = {
  indigo: { bg: 'bg-indigo-500/10', icon: 'text-indigo-400', glow: 'shadow-indigo-500/5' },
  emerald: { bg: 'bg-emerald-500/10', icon: 'text-emerald-400', glow: 'shadow-emerald-500/5' },
  red: { bg: 'bg-red-500/10', icon: 'text-red-400', glow: 'shadow-red-500/5' },
  violet: { bg: 'bg-violet-500/10', icon: 'text-violet-400', glow: 'shadow-violet-500/5' },
  amber: { bg: 'bg-amber-500/10', icon: 'text-amber-400', glow: 'shadow-amber-500/5' },
}

function StatCard({ label, value, icon, color }: { label: string; value: string; icon: React.ReactNode; color: string }) {
  const c = COLORS[color] || COLORS.indigo
  return (
    <div className={`card-glow bg-gray-900/50 rounded-xl p-5 backdrop-blur shadow-lg ${c.glow}`}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</span>
        <div className={`${c.bg} ${c.icon} p-2 rounded-lg`}>{icon}</div>
      </div>
      <div className="text-2xl font-bold text-white">{value}</div>
    </div>
  )
}

function MetricCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl p-4 border ${accent ? 'bg-indigo-500/5 border-indigo-500/20' : 'bg-gray-900/50 border-gray-800/50'}`}>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-xl font-bold ${accent ? 'text-indigo-400' : 'text-white'}`}>{value}</div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const isActive = status === 'active'
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium ${
      isActive ? 'bg-emerald-500/10 text-emerald-400 badge-active' : 'bg-gray-800/50 text-gray-500'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-emerald-400 animate-pulse' : 'bg-gray-600'}`} />
      {status}
    </span>
  )
}
