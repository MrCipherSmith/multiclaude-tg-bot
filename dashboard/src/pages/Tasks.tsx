import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type AgentTaskRow } from '../api/client'
import { useI18n } from '../i18n'

const STATUS_FILTER_OPTIONS = ['all', 'pending', 'in_progress', 'completed', 'failed', 'waiting_approval'] as const
type StatusFilter = (typeof STATUS_FILTER_OPTIONS)[number]

/**
 * Tasks page (PRD §16). Flat list with status filter + reassign action.
 * The full DAG view is intentionally not shipped here — most projects
 * have shallow trees and the parent_task_id column lets the user pivot
 * via a one-click "show children" filter without rendering a graph.
 */
export function TasksPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [parentFocus, setParentFocus] = useState<number | null>(null)

  const { data: tasks, isLoading, error, refetch } = useQuery({
    queryKey: ['tasks', filter, parentFocus],
    queryFn: () =>
      api.tasks({
        status: filter === 'all' ? undefined : filter,
        parent_task_id: parentFocus != null ? parentFocus : undefined,
      }),
    refetchInterval: 5_000,
  })

  const reassignMut = useMutation({
    mutationFn: (id: number) => api.reassignTask(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tasks'] }),
  })

  if (isLoading) return <div className="text-gray-400">{t('common.loading')}</div>
  if (error) return <div className="text-red-400">{t('common.error')}: {(error as Error).message}</div>

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-white">Tasks</h1>
        <button
          onClick={() => refetch()}
          className="text-sm text-gray-400 hover:text-white px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700"
        >
          {t('common.refresh')}
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        {STATUS_FILTER_OPTIONS.map((opt) => (
          <button
            key={opt}
            onClick={() => setFilter(opt)}
            className={`text-xs px-3 py-1.5 rounded border ${
              filter === opt
                ? 'bg-indigo-500/10 text-white border-indigo-500'
                : 'bg-gray-900 text-gray-400 border-gray-800 hover:border-gray-700 hover:text-white'
            }`}
          >
            {opt}
          </button>
        ))}
        {parentFocus != null && (
          <span className="text-xs text-gray-500 ml-auto">
            children of #{parentFocus}{' '}
            <button
              onClick={() => setParentFocus(null)}
              className="text-indigo-400 hover:text-indigo-300 underline ml-1"
            >
              clear
            </button>
          </span>
        )}
      </div>

      {/* Tasks table */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-800/50 text-xs text-gray-400">
              <th className="text-left px-4 py-2 font-medium">#</th>
              <th className="text-left px-4 py-2 font-medium">Title</th>
              <th className="text-left px-4 py-2 font-medium">Status</th>
              <th className="text-left px-4 py-2 font-medium">Agent</th>
              <th className="text-left px-4 py-2 font-medium">Parent</th>
              <th className="text-left px-4 py-2 font-medium">Updated</th>
              <th className="text-left px-4 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {(tasks ?? []).map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onPivot={(parentId) => setParentFocus(parentId)}
                onReassign={() => reassignMut.mutate(task.id)}
                isReassigning={reassignMut.isPending}
              />
            ))}
            {(tasks?.length ?? 0) === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-gray-500">
                  No tasks{filter !== 'all' ? ` with status "${filter}"` : ''}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function TaskRow({
  task,
  onPivot,
  onReassign,
  isReassigning,
}: {
  task: AgentTaskRow
  onPivot: (parentId: number) => void
  onReassign: () => void
  isReassigning: boolean
}) {
  const statusColor =
    task.status === 'completed'
      ? 'text-green-400'
      : task.status === 'failed'
        ? 'text-red-400'
        : task.status === 'in_progress' || task.status === 'pending'
          ? 'text-blue-400'
          : task.status === 'waiting_approval'
            ? 'text-purple-400'
            : 'text-gray-400'
  const updated = new Date(task.updatedAt).toLocaleString()
  return (
    <tr className="hover:bg-gray-800/30">
      <td className="px-4 py-2 text-gray-500 font-mono">{task.id}</td>
      <td className="px-4 py-2 text-white">{task.title}</td>
      <td className="px-4 py-2">
        <span className={`text-xs font-mono ${statusColor}`}>{task.status}</span>
      </td>
      <td className="px-4 py-2 text-gray-400 text-xs">{task.agentInstanceId ?? '—'}</td>
      <td className="px-4 py-2 text-xs">
        {/*
          Parent column. The button label shows the parent task's id and
          drilling into it filters by parent_task_id == that id (i.e. shows
          siblings of this row). Earlier impl passed task.id (children of
          self) which mismatched the visible label and broke navigation —
          fixed in F-003.
        */}
        {task.parentTaskId != null ? (
          <button
            onClick={() => onPivot(task.parentTaskId!)}
            className="text-indigo-400 hover:text-indigo-300 underline"
            title="show siblings under this parent"
          >
            #{task.parentTaskId} ⇡
          </button>
        ) : (
          <span className="text-gray-600">root</span>
        )}
      </td>
      <td className="px-4 py-2 text-gray-500 text-xs whitespace-nowrap">{updated}</td>
      <td className="px-4 py-2">
        {task.status === 'failed' && (
          <button
            onClick={onReassign}
            disabled={isReassigning}
            className="text-xs px-2.5 py-1 rounded bg-blue-900/40 text-blue-400 hover:bg-blue-900/70 disabled:opacity-50 transition-colors"
          >
            reassign
          </button>
        )}
      </td>
    </tr>
  )
}
