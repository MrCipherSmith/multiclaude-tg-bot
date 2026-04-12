import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, type ProcessHealthRow } from '../api/client'

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

function fmtAge(dateStr: string): string {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (s < 10) return 'now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

function StatusDot({ status, stale }: { status: string; stale?: boolean }) {
  if (stale) return <span className="inline-block w-2 h-2 rounded-full bg-yellow-400" title="Stale heartbeat" />
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${status === 'running' ? 'bg-green-500' : 'bg-red-500'}`}
    />
  )
}

export function MonitorPage() {
  const queryClient = useQueryClient()

  const { data, isLoading, error } = useQuery({
    queryKey: ['process-health'],
    queryFn: api.processHealth,
    refetchInterval: 15_000,
  })

  const restartDaemon = useMutation({
    mutationFn: api.restartDaemon,
    onSuccess: () => setTimeout(() => queryClient.invalidateQueries({ queryKey: ['process-health'] }), 3000),
  })

  const restartDocker = useMutation({
    mutationFn: (container: string) => api.restartDockerContainer(container),
    onSuccess: () => setTimeout(() => queryClient.invalidateQueries({ queryKey: ['process-health'] }), 5000),
  })

  if (isLoading) return <div className="text-gray-400">Loading...</div>
  if (error) return <div className="text-red-400">Error: {(error as Error).message}</div>
  if (!data) return null

  const daemonRow = data.health.find((r) => r.name === 'admin-daemon')
  const dockerRows = data.health.filter((r) => r.name.startsWith('docker:'))

  const daemonStale = daemonRow
    ? Date.now() - new Date(daemonRow.updated_at).getTime() > 90_000
    : false

  const botContainer = dockerRows.find((r) => r.name.includes('bot-') || r.name.includes('-bot'))

  // Group by prefix
  const dockerGroups: Record<string, typeof dockerRows> = {}
  for (const row of dockerRows) {
    const cname = row.name.slice('docker:'.length)
    const prefix = cname.includes('-') ? cname.split('-')[0] : cname
    if (!dockerGroups[prefix]) dockerGroups[prefix] = []
    dockerGroups[prefix].push(row)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Process Monitor</h1>
        <button
          onClick={() => queryClient.invalidateQueries({ queryKey: ['process-health'] })}
          className="text-sm text-gray-400 hover:text-white transition-colors"
        >
          ↻ Refresh
        </button>
      </div>

      {/* admin-daemon */}
      <section className="bg-gray-900/60 border border-gray-800/50 rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">admin-daemon</h2>
          <button
            onClick={() => restartDaemon.mutate()}
            disabled={restartDaemon.isPending}
            className="text-xs px-3 py-1.5 rounded-lg bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 disabled:opacity-40 transition-colors"
          >
            {restartDaemon.isPending ? 'Restarting…' : '🔄 Restart daemon'}
          </button>
        </div>
        {daemonRow ? (
          <DaemonRow row={daemonRow} stale={daemonStale} />
        ) : (
          <div className="flex items-center gap-3">
            <StatusDot status="stopped" />
            <span className="text-red-400 text-sm">Not running</span>
            <code className="text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded ml-2">
              bun scripts/admin-daemon.ts
            </code>
          </div>
        )}
      </section>

      {/* Docker containers */}
      <section className="bg-gray-900/60 border border-gray-800/50 rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Docker</h2>
          {botContainer && (
            <button
              onClick={() => restartDocker.mutate(botContainer.name.slice('docker:'.length))}
              disabled={restartDocker.isPending}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 disabled:opacity-40 transition-colors"
            >
              {restartDocker.isPending ? 'Restarting…' : '🔄 Restart bot'}
            </button>
          )}
        </div>
        {dockerRows.length === 0 ? (
          <p className="text-gray-500 text-sm">No containers found — admin-daemon may not be running.</p>
        ) : (
          <div className="divide-y divide-gray-800/50">
            {Object.entries(dockerGroups).map(([prefix, rows]) => (
              <div key={prefix} className="py-2 first:pt-0 last:pb-0">
                <div className="text-[10px] font-semibold text-gray-600 uppercase tracking-widest mb-1.5">{prefix}</div>
                <div className="space-y-1.5">
                  {rows.map((row) => <DockerRow key={row.name} row={row} />)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* tmux sessions */}
      <section className="bg-gray-900/60 border border-gray-800/50 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide mb-3">tmux Sessions</h2>
        <div className="flex items-center gap-3">
          <span className="text-2xl font-bold text-white">{data.activeSessionCount}</span>
          <span className="text-gray-400 text-sm">active session{data.activeSessionCount !== 1 ? 's' : ''}</span>
        </div>
      </section>
    </div>
  )
}

function DaemonRow({ row, stale }: { row: ProcessHealthRow; stale: boolean }) {
  const detail = row.detail as { pid?: number; uptime_ms?: number } | null
  const uptime = detail?.uptime_ms != null ? fmtUptime(detail.uptime_ms) : '?'

  return (
    <div className="flex flex-wrap items-center gap-3">
      <StatusDot status={row.status} stale={stale} />
      <span className={`text-sm font-medium ${stale ? 'text-yellow-400' : 'text-white'}`}>
        {row.status === 'running' ? 'Running' : 'Stopped'}
      </span>
      {detail?.pid && (
        <span className="text-xs text-gray-500">PID {detail.pid}</span>
      )}
      <span className="text-xs text-gray-500">⏱ {uptime}</span>
      {stale && (
        <span className="text-xs text-yellow-500">
          ⚠ last heartbeat {fmtAge(row.updated_at)}
        </span>
      )}
      {!stale && (
        <span className="text-xs text-gray-600">updated {fmtAge(row.updated_at)}</span>
      )}
    </div>
  )
}

function DockerRow({ row }: { row: ProcessHealthRow }) {
  const cname = row.name.slice('docker:'.length)
  const detail = row.detail as { status?: string } | null
  const running = row.status === 'running'
  return (
    <div className="flex items-center gap-3">
      <StatusDot status={row.status} />
      <span className={`text-sm font-medium ${running ? 'text-white' : 'text-red-400'}`}>{cname}</span>
      {detail?.status && (
        <span className="text-xs text-gray-500">{detail.status}</span>
      )}
    </div>
  )
}
