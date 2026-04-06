import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type ApiError } from '../api/client'
import { useI18n } from '../i18n'
import { SlidePanel } from '../components/SlidePanel'

const fmt = new Intl.NumberFormat()
const fmtCost = (v: number) => v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`

function shortPath(p: string): string {
  const parts = p.replace(/^\/home\/[^/]+\//, '~/').split('/')
  return parts.length > 3 ? `.../${parts.slice(-2).join('/')}` : parts.join('/')
}

function timeAgo(ts: string): string {
  const ms = Date.now() - new Date(ts).getTime()
  if (ms < 60_000) return '<1m'
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h`
  return `${Math.floor(ms / 86400_000)}d`
}

export function StatsPage() {
  const [timeWindow, setTimeWindow] = useState<string>('24h')
  const [panelError, setPanelError] = useState<ApiError | null>(null)
  const [showErrors, setShowErrors] = useState(false)
  const { t } = useI18n()

  const { data: stats, isLoading, error } = useQuery({
    queryKey: ['stats'],
    queryFn: api.stats,
  })

  const { data: dailyStats } = useQuery({
    queryKey: ['daily-stats'],
    queryFn: () => api.dailyStats(30),
  })

  const { data: recentErrors } = useQuery({
    queryKey: ['recent-errors'],
    queryFn: () => api.recentErrors(20),
  })

  if (isLoading) return <div className="text-gray-400">{t('common.loading')}</div>
  if (error) return <div className="text-red-400">{t('common.error')}: {(error as Error).message}</div>
  if (!stats) return null

  const w = stats.api[timeWindow]
  const maxTokens = dailyStats ? Math.max(...dailyStats.map((d) => d.total_tokens), 1) : 1

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-white">{t('stats.title')}</h1>

      <div className="flex gap-1 bg-gray-900 rounded-lg p-1 border border-gray-800 w-fit">
        {['24h', 'startup', 'total'].map((tw) => (
          <button key={tw} onClick={() => setTimeWindow(tw)} className={`px-3 py-1 text-sm rounded ${timeWindow === tw ? 'bg-gray-700 text-white' : 'text-gray-400 hover:text-white'}`}>
            {tw}
          </button>
        ))}
      </div>

      {w && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <Card label={t('stats.totalRequests')} value={fmt.format(w.summary.total)} sub={w.summary.errors > 0 ? `${w.summary.errors} ${t('stats.errors')}` : undefined} subClass={w.summary.errors > 0 ? 'text-red-400 cursor-pointer hover:underline' : undefined} onSubClick={w.summary.errors > 0 ? () => setShowErrors(true) : undefined} />
          <Card label={t('stats.totalTokens')} value={fmt.format(w.summary.total_tokens)} sub={`${t('stats.in')}: ${fmt.format(w.summary.input_tokens)} / ${t('stats.out')}: ${fmt.format(w.summary.output_tokens)}`} />
          <Card label={t('stats.avgLatency')} value={`${w.summary.avg_latency_ms}ms`} />
          <Card label={t('stats.successRate')} value={w.summary.total > 0 ? `${Math.round((w.summary.success / w.summary.total) * 100)}%` : '-'} />
          <Card label={t('stats.cost')} value={fmtCost(w.summary.estimated_cost)} sub="estimated" />
        </div>
      )}

      {dailyStats && dailyStats.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-gray-400 mb-3">{t('stats.tokensChart')}</h2>
          <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
            <div className="flex items-end gap-1 h-48">
              {dailyStats.map((d) => (
                <div key={d.date} className="flex-1 min-w-[4px] bg-blue-500 rounded-t hover:bg-blue-400 transition-colors" style={{ height: `${Math.max((d.total_tokens / maxTokens) * 100, 2)}%` }} title={`${d.date}\n${fmt.format(d.total_tokens)} ${t('stats.tokens')}\n${d.requests} ${t('stats.totalRequests').toLowerCase()}`} />
              ))}
            </div>
            <div className="flex justify-between mt-2 text-xs text-gray-600">
              <span>{dailyStats[0]?.date}</span>
              <span>{dailyStats[dailyStats.length - 1]?.date}</span>
            </div>
          </div>
        </div>
      )}

      {w && w.byProvider.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-gray-400 mb-3">{t('stats.byProvider')}</h2>
          <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="bg-gray-800/50 text-gray-400">
                <th className="text-left px-4 py-2 font-medium">{t('stats.provider')}</th>
                <th className="text-left px-4 py-2 font-medium">{t('stats.model')}</th>
                <th className="text-right px-4 py-2 font-medium">{t('stats.totalRequests')}</th>
                <th className="text-right px-4 py-2 font-medium">{t('stats.inputTokens')}</th>
                <th className="text-right px-4 py-2 font-medium">{t('stats.outputTokens')}</th>
                <th className="text-right px-4 py-2 font-medium">{t('stats.avgLatency')}</th>
                <th className="text-right px-4 py-2 font-medium">{t('stats.cost')}</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-800">
                {w.byProvider.map((p, i) => (
                  <tr key={i} className="hover:bg-gray-800/30">
                    <td className="px-4 py-2 text-white">{p.provider}</td>
                    <td className="px-4 py-2 text-gray-400 text-xs">{p.model}</td>
                    <td className="px-4 py-2 text-right">{fmt.format(p.requests)}</td>
                    <td className="px-4 py-2 text-right text-gray-400">{fmt.format(p.input_tokens)}</td>
                    <td className="px-4 py-2 text-right text-gray-400">{fmt.format(p.output_tokens)}</td>
                    <td className="px-4 py-2 text-right text-gray-400">{p.avg_ms}ms</td>
                    <td className="px-4 py-2 text-right text-green-400">{fmtCost(p.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {w && w.byProject && w.byProject.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-gray-400 mb-3">{t('stats.byProject')}</h2>
          <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="bg-gray-800/50 text-gray-400">
                <th className="text-left px-4 py-2 font-medium">{t('stats.project')}</th>
                <th className="text-right px-4 py-2 font-medium">{t('stats.sessions')}</th>
                <th className="text-right px-4 py-2 font-medium">{t('stats.totalRequests')}</th>
                <th className="text-right px-4 py-2 font-medium">{t('stats.inputTokens')}</th>
                <th className="text-right px-4 py-2 font-medium">{t('stats.outputTokens')}</th>
                <th className="text-right px-4 py-2 font-medium">{t('stats.tokens')}</th>
                <th className="text-right px-4 py-2 font-medium">{t('stats.avgLatency')}</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-800">
                {w.byProject.map((p, i) => (
                  <tr key={i} className="hover:bg-gray-800/30">
                    <td className="px-4 py-2 text-white text-xs" title={p.project}>{shortPath(p.project)}</td>
                    <td className="px-4 py-2 text-right text-gray-400">{p.sessions}</td>
                    <td className="px-4 py-2 text-right">{fmt.format(p.requests)}</td>
                    <td className="px-4 py-2 text-right text-gray-400">{fmt.format(p.input_tokens)}</td>
                    <td className="px-4 py-2 text-right text-gray-400">{fmt.format(p.output_tokens)}</td>
                    <td className="px-4 py-2 text-right">{fmt.format(p.tokens)}</td>
                    <td className="px-4 py-2 text-right text-gray-400">{p.avg_ms}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {w && w.byOperation && w.byOperation.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-gray-400 mb-3">{t('stats.byOperation')}</h2>
          <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="bg-gray-800/50 text-gray-400">
                <th className="text-left px-4 py-2 font-medium">{t('stats.operation')}</th>
                <th className="text-right px-4 py-2 font-medium">{t('stats.totalRequests')}</th>
                <th className="text-right px-4 py-2 font-medium">{t('stats.inputTokens')}</th>
                <th className="text-right px-4 py-2 font-medium">{t('stats.outputTokens')}</th>
                <th className="text-right px-4 py-2 font-medium">{t('stats.tokens')}</th>
                <th className="text-right px-4 py-2 font-medium">{t('stats.errors')}</th>
                <th className="text-right px-4 py-2 font-medium">{t('stats.avgLatency')}</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-800">
                {w.byOperation.map((op, i) => (
                  <tr key={i} className="hover:bg-gray-800/30">
                    <td className="px-4 py-2 text-white">{op.operation}</td>
                    <td className="px-4 py-2 text-right">{fmt.format(op.requests)}</td>
                    <td className="px-4 py-2 text-right text-gray-400">{fmt.format(op.input_tokens)}</td>
                    <td className="px-4 py-2 text-right text-gray-400">{fmt.format(op.output_tokens)}</td>
                    <td className="px-4 py-2 text-right">{fmt.format(op.tokens)}</td>
                    <td className="px-4 py-2 text-right">{op.errors > 0 ? <span className="text-red-400">{op.errors}</span> : '0'}</td>
                    <td className="px-4 py-2 text-right text-gray-400">{op.avg_ms}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {w && w.bySession.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-gray-400 mb-3">{t('stats.bySession')}</h2>
          <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="bg-gray-800/50 text-gray-400">
                <th className="text-left px-4 py-2 font-medium">{t('nav.sessions')}</th>
                <th className="text-left px-4 py-2 font-medium">{t('stats.project')}</th>
                <th className="text-right px-4 py-2 font-medium">{t('stats.totalRequests')}</th>
                <th className="text-right px-4 py-2 font-medium">{t('stats.inputTokens')}</th>
                <th className="text-right px-4 py-2 font-medium">{t('stats.outputTokens')}</th>
                <th className="text-right px-4 py-2 font-medium">{t('stats.avgLatency')}</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-800">
                {w.bySession.map((s, i) => (
                  <tr key={i} className="hover:bg-gray-800/30">
                    <td className="px-4 py-2 text-white">{s.session_name || `#${s.session_id}`}</td>
                    <td className="px-4 py-2 text-gray-500 text-xs" title={s.project_path || ''}>{s.project_path ? shortPath(s.project_path) : '-'}</td>
                    <td className="px-4 py-2 text-right">{fmt.format(s.requests)}</td>
                    <td className="px-4 py-2 text-right text-gray-400">{fmt.format(s.input_tokens)}</td>
                    <td className="px-4 py-2 text-right text-gray-400">{fmt.format(s.output_tokens)}</td>
                    <td className="px-4 py-2 text-right text-gray-400">{s.avg_ms}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {stats.transcription.total?.summary?.total > 0 && (
        <div>
          <h2 className="text-sm font-medium text-gray-400 mb-3">{t('stats.transcription')}</h2>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
            <Card label={t('stats.total')} value={String(stats.transcription.total.summary.total)} />
            <Card label={t('stats.success')} value={String(stats.transcription.total.summary.success)} />
            <Card label={t('stats.avgLatency')} value={`${stats.transcription.total.summary.avg_latency_ms}ms`} />
          </div>
        </div>
      )}

      {/* Errors drawer */}
      <SlidePanel open={showErrors} onClose={() => { setShowErrors(false); setPanelError(null) }} title={`Recent Errors (${recentErrors?.length ?? 0})`} width="max-w-2xl">
        {panelError ? (
          <div className="space-y-4">
            <button onClick={() => setPanelError(null)} className="text-sm text-gray-400 hover:text-white">&larr; Back</button>
            <div className="space-y-3">
              <div>
                <div className="text-xs text-gray-500">Model</div>
                <div className="text-white text-sm">{panelError.model}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Operation</div>
                <div className="text-white text-sm">{panelError.operation}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Session</div>
                <div className="text-white text-sm">{panelError.session_name || '-'}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Project</div>
                <div className="text-white text-sm">{panelError.project_path || '-'}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Time</div>
                <div className="text-white text-sm">{new Date(panelError.created_at).toLocaleString()}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Duration</div>
                <div className="text-white text-sm">{panelError.duration_ms}ms</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-1">Error Message</div>
                <pre className="text-red-400 text-xs bg-gray-950 rounded p-3 whitespace-pre-wrap break-all overflow-auto max-h-96">{panelError.error_message}</pre>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            {recentErrors?.map((e, i) => (
              <button key={i} onClick={() => setPanelError(e)} className="w-full text-left px-3 py-2 rounded hover:bg-gray-800 transition-colors">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-red-400 font-mono">{e.operation}</span>
                  <span className="text-xs text-gray-600">{timeAgo(e.created_at)}</span>
                </div>
                <div className="text-xs text-gray-400 truncate mt-0.5">{e.model}</div>
                <div className="text-xs text-gray-500 truncate mt-0.5">{e.error_message?.slice(0, 100)}</div>
              </button>
            ))}
            {(!recentErrors || recentErrors.length === 0) && (
              <div className="text-gray-500 text-sm text-center py-8">No errors</div>
            )}
          </div>
        )}
      </SlidePanel>
    </div>
  )
}

function Card({ label, value, sub, subClass, onSubClick }: { label: string; value: string; sub?: string; subClass?: string; onSubClick?: () => void }) {
  return (
    <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className="text-lg font-semibold text-white">{value}</div>
      {sub && <div className={`text-xs mt-1 ${subClass || 'text-gray-500'}`} onClick={onSubClick}>{sub}</div>}
    </div>
  )
}
