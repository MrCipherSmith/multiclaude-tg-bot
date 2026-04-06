import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useReactTable, getCoreRowModel, flexRender, createColumnHelper } from '@tanstack/react-table'
import { api, type LogEntry, type Session } from '../api/client'
import { useI18n } from '../i18n'
import { SlidePanel } from '../components/SlidePanel'

const LEVEL_STYLES: Record<string, string> = {
  info: 'bg-gray-800 text-gray-400',
  warn: 'bg-amber-900/40 text-amber-400',
  error: 'bg-red-900/40 text-red-400',
}

export function LogsPage() {
  const [sessionId, setSessionId] = useState<number | undefined>()
  const [level, setLevel] = useState<string | undefined>()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null)
  const { t } = useI18n()

  const { data: sessions } = useQuery({ queryKey: ['sessions'], queryFn: api.sessions })

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['logs', { sessionId, level, search, page }],
    queryFn: () => api.logs({ session_id: sessionId, level, search: search || undefined, limit: 50, offset: page * 50 }),
  })

  const col = createColumnHelper<LogEntry>()
  const columns = [
    col.accessor('created_at', { header: t('logs.time'), size: 140, cell: (info) => new Date(info.getValue()).toLocaleString() }),
    col.accessor('session_name', { header: t('logs.session'), size: 120, cell: (info) => info.getValue() || <span className="text-gray-600">-</span> }),
    col.accessor('level', { header: t('logs.level'), size: 70, cell: (info) => <span className={`text-xs px-2 py-0.5 rounded ${LEVEL_STYLES[info.getValue()] || LEVEL_STYLES.info}`}>{info.getValue()}</span> }),
    col.accessor('stage', { header: t('logs.stage'), size: 100 }),
    col.accessor('message', { header: t('logs.message'), cell: (info) => (
      <span className="truncate block max-w-md cursor-pointer hover:text-white text-gray-300" onClick={() => setSelectedLog(info.row.original)}>
        {info.getValue()}
      </span>
    )}),
  ]

  const table = useReactTable({ data: data?.logs ?? [], columns, getCoreRowModel: getCoreRowModel() })
  const totalPages = data ? Math.ceil(data.total / 50) : 0

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-white">{t('logs.title')}</h1>
        <button onClick={() => refetch()} className="text-sm text-gray-400 hover:text-white px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700">{t('common.refresh')}</button>
      </div>

      <div className="flex flex-wrap gap-3">
        <select value={sessionId ?? ''} onChange={(e) => { setSessionId(e.target.value ? Number(e.target.value) : undefined); setPage(0) }} className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-300">
          <option value="">{t('logs.allSessions')}</option>
          {sessions?.map((s: Session) => <option key={s.id} value={s.id}>{s.name || `#${s.id}`}</option>)}
        </select>
        <select value={level ?? ''} onChange={(e) => { setLevel(e.target.value || undefined); setPage(0) }} className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-300">
          <option value="">{t('logs.allLevels')}</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <input type="text" placeholder={t('logs.search')} value={search} onChange={(e) => { setSearch(e.target.value); setPage(0) }} className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-300 w-64" />
      </div>

      {isLoading && <div className="text-gray-400">{t('common.loading')}</div>}
      {error && <div className="text-red-400">{t('common.error')}: {(error as Error).message}</div>}

      {data && (
        <>
          <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>{table.getHeaderGroups().map((hg) => (
                <tr key={hg.id} className="bg-gray-800/50">
                  {hg.headers.map((h) => <th key={h.id} className="text-left px-4 py-2 font-medium text-gray-400">{flexRender(h.column.columnDef.header, h.getContext())}</th>)}
                </tr>
              ))}</thead>
              <tbody className="divide-y divide-gray-800">
                {table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className="hover:bg-gray-800/30 cursor-pointer" onClick={() => setSelectedLog(row.original)}>
                    {row.getVisibleCells().map((cell) => <td key={cell.id} className="px-4 py-2">{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}
                  </tr>
                ))}
                {data.logs.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">{t('logs.noLogs')}</td></tr>}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">{page * 50 + 1}-{Math.min((page + 1) * 50, data.total)} {t('logs.of')} {data.total}</span>
              <div className="flex gap-2">
                <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="text-sm px-3 py-1 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-40">{t('common.previous')}</button>
                <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)} className="text-sm px-3 py-1 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-40">{t('common.next')}</button>
              </div>
            </div>
          )}
        </>
      )}

      <SlidePanel open={!!selectedLog} onClose={() => setSelectedLog(null)} title="Log Detail" width="max-w-2xl">
        {selectedLog && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-gray-500">{t('logs.time')}</div>
                <div className="text-white text-sm">{new Date(selectedLog.created_at).toLocaleString()}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">{t('logs.session')}</div>
                <div className="text-white text-sm">{selectedLog.session_name || `#${selectedLog.session_id}`}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">{t('logs.level')}</div>
                <span className={`text-xs px-2 py-0.5 rounded ${LEVEL_STYLES[selectedLog.level] || LEVEL_STYLES.info}`}>{selectedLog.level}</span>
              </div>
              <div>
                <div className="text-xs text-gray-500">{t('logs.stage')}</div>
                <div className="text-white text-sm">{selectedLog.stage}</div>
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1">{t('logs.message')}</div>
              <pre className="text-gray-200 text-xs bg-gray-950 rounded p-3 whitespace-pre-wrap break-all overflow-auto max-h-[70vh]">{selectedLog.message}</pre>
            </div>
          </div>
        )}
      </SlidePanel>
    </div>
  )
}
