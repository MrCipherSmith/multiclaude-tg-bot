import { useQuery } from '@tanstack/react-query'
import {
  useReactTable, getCoreRowModel, getSortedRowModel, flexRender, createColumnHelper, type SortingState,
} from '@tanstack/react-table'
import { Link } from '@tanstack/react-router'
import { useState, useMemo } from 'react'
import { api, type Session } from '../api/client'
import { useI18n } from '../i18n'

export function SessionsPage() {
  const [sorting, setSorting] = useState<SortingState>([])
  const { t } = useI18n()

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['sessions'],
    queryFn: api.sessions,
  })

  const col = createColumnHelper<Session>()

  const columns = useMemo(() => [
    col.accessor('id', { header: t('sessions.id'), size: 60 }),
    col.accessor('name', {
      header: t('sessions.name'),
      cell: (info) => (
        <Link to="/sessions/$id" params={{ id: String(info.row.original.id) }} className="text-blue-400 hover:text-blue-300">
          {info.getValue() || `Session #${info.row.original.id}`}
        </Link>
      ),
    }),
    col.accessor('project_path', {
      header: t('sessions.project'),
      cell: (info) => {
        const val = info.getValue()
        return val ? <span className="text-gray-400">{val.split('/').pop()}</span> : <span className="text-gray-600">-</span>
      },
    }),
    col.accessor('status', {
      header: t('sessions.status'),
      cell: (info) => {
        const active = info.getValue() === 'active'
        return (
          <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full ${active ? 'bg-green-900/40 text-green-400' : 'bg-gray-800 text-gray-500'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-green-400' : 'bg-gray-600'}`} />
            {active ? t('sessions.active') : t('sessions.disconnected')}
          </span>
        )
      },
    }),
    col.accessor('last_active', {
      header: t('sessions.lastActive'),
      cell: (info) => {
        const diff = (Date.now() - new Date(info.getValue()).getTime()) / 1000
        if (diff < 60) return t('common.justNow')
        if (diff < 3600) return t('common.mAgo', { n: Math.floor(diff / 60) })
        if (diff < 86400) return t('common.hAgo', { n: Math.floor(diff / 3600) })
        return t('common.dAgo', { n: Math.floor(diff / 86400) })
      },
    }),
  ], [t, col])

  const table = useReactTable({
    data: data ?? [],
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  if (isLoading) return <div className="text-gray-400">{t('common.loading')}</div>
  if (error) return <div className="text-red-400">{t('common.error')}: {(error as Error).message}</div>

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-white">{t('sessions.title')}</h1>
        <button onClick={() => refetch()} className="text-sm text-gray-400 hover:text-white px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700">
          {t('common.refresh')}
        </button>
      </div>

      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="bg-gray-800/50">
                {hg.headers.map((h) => (
                  <th key={h.id} className="text-left px-4 py-2 font-medium text-gray-400 cursor-pointer select-none hover:text-white" onClick={h.column.getToggleSortingHandler()}>
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {{ asc: ' \u2191', desc: ' \u2193' }[h.column.getIsSorted() as string] ?? ''}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-gray-800">
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className="hover:bg-gray-800/30">
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-4 py-2">{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                ))}
              </tr>
            ))}
            {(data?.length ?? 0) === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">{t('sessions.noSessions')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
