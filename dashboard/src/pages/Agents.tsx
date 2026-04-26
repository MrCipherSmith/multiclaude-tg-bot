import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { useI18n } from '../i18n'

/**
 * Agents page (PRD §16). Lists agent_definitions and agent_instances side
 * by side. The instances table supports start / stop / restart actions —
 * each routes through /api/agents/:id/{action} which mutates desired_state
 * and lets the reconciler converge actual_state on the next tick.
 *
 * Drift indicator (red text) shows when desired_state ≠ actual_state and
 * the desired side is not "stopped" — this surfaces stuck transitions
 * that the reconciler is still working on (or failing to resolve).
 */
export function AgentsPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data: instances, isLoading: instLoading, error: instError, refetch } = useQuery({
    queryKey: ['agents-instances'],
    queryFn: () => api.agents(),
    refetchInterval: 5_000,
  })
  const { data: definitions, isLoading: defLoading } = useQuery({
    queryKey: ['agents-definitions'],
    queryFn: () => api.agentDefinitions(),
    staleTime: 60_000,
  })
  const { data: status } = useQuery({
    queryKey: ['runtime-status'],
    queryFn: () => api.runtimeStatus(),
    refetchInterval: 5_000,
  })

  const actionMut = useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'start' | 'stop' | 'restart' }) =>
      api.agentAction(id, action),
    onSuccess: () => {
      // Both queries derive from the same underlying state; invalidate
      // both so the runtime-status strip at the top of the page reflects
      // start/stop/restart immediately instead of waiting up to 5s for
      // the next poll tick.
      queryClient.invalidateQueries({ queryKey: ['agents-instances'] })
      queryClient.invalidateQueries({ queryKey: ['runtime-status'] })
    },
  })

  if (instLoading || defLoading) return <div className="text-gray-400">{t('common.loading')}</div>
  if (instError) return <div className="text-red-400">{t('common.error')}: {(instError as Error).message}</div>

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-white">Agents</h1>
        <button
          onClick={() => refetch()}
          className="text-sm text-gray-400 hover:text-white px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700"
        >
          {t('common.refresh')}
        </button>
      </div>

      {/* Runtime status strip */}
      {status && (
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-4 grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <Stat label="Running" value={status.totals.running_instances} tone="green" />
          <Stat label="Stopped" value={status.totals.stopped_instances} tone="muted" />
          <Stat
            label="Drift"
            value={status.totals.desired_actual_drift}
            tone={status.totals.desired_actual_drift > 0 ? 'red' : 'muted'}
          />
          <Stat
            label="Failed tasks"
            value={status.totals.failed_tasks}
            tone={status.totals.failed_tasks > 0 ? 'red' : 'muted'}
          />
        </div>
      )}

      {/* Definitions */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        <h2 className="text-sm font-medium text-gray-300 px-4 py-3 border-b border-gray-800">
          Agent Definitions
        </h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-800/50 text-xs text-gray-400">
              <th className="text-left px-4 py-2 font-medium">#</th>
              <th className="text-left px-4 py-2 font-medium">Name</th>
              <th className="text-left px-4 py-2 font-medium">Runtime</th>
              <th className="text-left px-4 py-2 font-medium">Capabilities</th>
              <th className="text-left px-4 py-2 font-medium">Enabled</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {(definitions ?? []).map((d) => (
              <tr key={d.id} className="hover:bg-gray-800/30">
                <td className="px-4 py-2 text-gray-500 font-mono">{d.id}</td>
                <td className="px-4 py-2 text-white font-medium">{d.name}</td>
                <td className="px-4 py-2 text-gray-300 font-mono text-xs">{d.runtimeType}</td>
                <td className="px-4 py-2">
                  {d.capabilities.length === 0 ? (
                    <span className="text-gray-600">—</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {d.capabilities.map((c) => (
                        <span key={c} className="text-xs px-1.5 py-0.5 rounded bg-indigo-900/40 text-indigo-300 font-mono">
                          {c}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2">
                  <span className={d.enabled ? 'text-green-400' : 'text-gray-600'}>
                    {d.enabled ? 'on' : 'off'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Instances */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        <h2 className="text-sm font-medium text-gray-300 px-4 py-3 border-b border-gray-800">
          Agent Instances ({instances?.length ?? 0})
        </h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-800/50 text-xs text-gray-400">
              <th className="text-left px-4 py-2 font-medium">#</th>
              <th className="text-left px-4 py-2 font-medium">Name</th>
              <th className="text-left px-4 py-2 font-medium">Definition</th>
              <th className="text-left px-4 py-2 font-medium">Project</th>
              <th className="text-left px-4 py-2 font-medium">Desired</th>
              <th className="text-left px-4 py-2 font-medium">Actual</th>
              <th className="text-left px-4 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {(instances ?? []).map((i) => {
              // Drift = desired and actual are different. The previous guard
              // suppressed drift only when desired='stopped' which produced a
              // false positive any time a paused agent's actual_state lagged
              // behind a paused desired_state. Plain inequality is the right
              // signal — operators can interpret what direction the
              // reconciler is moving in via the desired/actual columns.
              const drift = i.desired_state !== i.actual_state
              return (
                <tr key={i.id} className="hover:bg-gray-800/30">
                  <td className="px-4 py-2 text-gray-500 font-mono">{i.id}</td>
                  <td className="px-4 py-2 text-white font-medium">{i.name}</td>
                  <td className="px-4 py-2 text-gray-400 font-mono text-xs">{i.definition_name ?? '—'}</td>
                  <td className="px-4 py-2 text-gray-400 text-xs">{i.project_name ?? '—'}</td>
                  <td className="px-4 py-2 text-gray-300 font-mono text-xs">{i.desired_state}</td>
                  <td className="px-4 py-2">
                    <ActualStateBadge state={i.actual_state} drift={drift} />
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      {i.actual_state !== 'running' && (
                        <button
                          onClick={() => actionMut.mutate({ id: i.id, action: 'start' })}
                          disabled={actionMut.isPending}
                          className="text-xs px-2.5 py-1 rounded bg-green-900/40 text-green-400 hover:bg-green-900/70 disabled:opacity-50 transition-colors"
                        >
                          start
                        </button>
                      )}
                      {i.actual_state === 'running' && (
                        <button
                          onClick={() => actionMut.mutate({ id: i.id, action: 'stop' })}
                          disabled={actionMut.isPending}
                          className="text-xs px-2.5 py-1 rounded bg-yellow-900/40 text-yellow-400 hover:bg-yellow-900/70 disabled:opacity-50 transition-colors"
                        >
                          stop
                        </button>
                      )}
                      <button
                        onClick={() => actionMut.mutate({ id: i.id, action: 'restart' })}
                        disabled={actionMut.isPending}
                        className="text-xs px-2.5 py-1 rounded bg-blue-900/40 text-blue-400 hover:bg-blue-900/70 disabled:opacity-50 transition-colors"
                      >
                        restart
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {(instances?.length ?? 0) === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-gray-500">
                  No agent instances. Run <span className="font-mono text-gray-400">helyx setup-agents</span> on the host to bootstrap.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone: 'green' | 'red' | 'muted' }) {
  const color = tone === 'green' ? 'text-green-400' : tone === 'red' ? 'text-red-400' : 'text-gray-400'
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-xl font-semibold ${color}`}>{value}</div>
    </div>
  )
}

function ActualStateBadge({ state, drift }: { state: string; drift: boolean }) {
  const color = state === 'running' || state === 'idle'
    ? 'bg-green-900/40 text-green-400'
    : state === 'busy' || state === 'starting'
      ? 'bg-blue-900/40 text-blue-400'
      : state === 'stopped' || state === 'new'
        ? 'bg-gray-800 text-gray-500'
        : state === 'waiting_approval'
          ? 'bg-purple-900/40 text-purple-400'
          : 'bg-red-900/40 text-red-400'
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`text-xs px-2 py-0.5 rounded font-mono ${color}`}>{state}</span>
      {drift && <span className="text-xs text-red-400" title="drift: desired ≠ actual">↻</span>}
    </span>
  )
}
