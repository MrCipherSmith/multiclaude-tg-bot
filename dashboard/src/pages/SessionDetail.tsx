import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { api } from '../api/client'
import { useI18n } from '../i18n'

export function SessionDetailPage() {
  const { id: idStr } = useParams({ strict: false }) as { id: string }
  const id = Number(idStr)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(0)
  const [editing, setEditing] = useState(false)
  const [newName, setNewName] = useState('')
  const { t } = useI18n()

  const { data: session, isLoading } = useQuery({
    queryKey: ['session', id],
    queryFn: () => api.session(id),
  })

  const { data: messagesData } = useQuery({
    queryKey: ['session-messages', id, page],
    queryFn: () => api.sessionMessages(id, 50, page * 50),
  })

  const handleRename = async () => {
    if (!newName.trim()) return
    await api.renameSession(id, newName.trim())
    setEditing(false)
    queryClient.invalidateQueries({ queryKey: ['session', id] })
  }

  const handleDelete = async () => {
    if (!confirm(t('session.deleteConfirm', { name: session?.name || '' }))) return
    await api.deleteSession(id)
    queryClient.invalidateQueries({ queryKey: ['sessions'] })
    navigate({ to: '/sessions' })
  }

  if (isLoading) return <div className="text-gray-400">{t('common.loading')}</div>
  if (!session) return <div className="text-red-400">{t('session.notFound')}</div>

  const totalPages = messagesData ? Math.ceil(messagesData.total / 50) : 0

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link to="/sessions" className="text-gray-400 hover:text-white">{'\u2190'} {t('session.back')}</Link>
        <span className="text-gray-600">/</span>
        {editing ? (
          <div className="flex items-center gap-2">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleRename()} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-white text-lg" autoFocus />
            <button onClick={handleRename} className="text-sm text-green-400 hover:text-green-300">{t('session.save')}</button>
            <button onClick={() => setEditing(false)} className="text-sm text-gray-400 hover:text-gray-300">{t('session.cancel')}</button>
          </div>
        ) : (
          <h1 className="text-xl font-semibold text-white">
            {session.name || `Session #${session.id}`}
            <button onClick={() => { setNewName(session.name || ''); setEditing(true) }} className="ml-2 text-sm text-gray-500 hover:text-gray-300">{t('session.edit')}</button>
          </h1>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <InfoCard label={t('sessions.status')} value={session.status} valueClass={session.status === 'active' ? 'text-green-400' : 'text-gray-400'} />
        <InfoCard label={t('sessions.project')} value={session.project_path?.split('/').pop() || '-'} />
        <InfoCard label={t('sessions.connectedAt')} value={new Date(session.connected_at).toLocaleString()} />
        <InfoCard label={t('sessions.lastActive')} value={new Date(session.last_active).toLocaleString()} />
        <InfoCard label={t('session.messageCount')} value={String(session.message_count)} />
      </div>

      <div>
        <button onClick={handleDelete} className="text-sm text-red-400 hover:text-red-300 px-3 py-1.5 rounded bg-red-900/20 hover:bg-red-900/40 border border-red-900/50">
          {t('session.delete')}
        </button>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-gray-400">{t('session.messages')} ({messagesData?.total ?? 0})</h2>
        </div>
        <div className="space-y-2 max-h-[600px] overflow-auto">
          {messagesData?.messages.slice().reverse().map((msg) => (
            <div key={msg.id} className={`rounded-lg p-3 text-sm whitespace-pre-wrap ${msg.role === 'user' ? 'bg-blue-900/20 border border-blue-900/30 ml-8' : 'bg-gray-800 border border-gray-700 mr-8'}`}>
              <div className="flex items-center justify-between mb-1">
                <span className={`text-xs font-medium ${msg.role === 'user' ? 'text-blue-400' : 'text-gray-400'}`}>
                  {msg.role === 'user' ? t('session.user') : t('session.assistant')}
                </span>
                <span className="text-xs text-gray-600">{new Date(msg.created_at).toLocaleTimeString()}</span>
              </div>
              <div className="text-gray-200">{msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content}</div>
            </div>
          ))}
          {(messagesData?.messages.length ?? 0) === 0 && (
            <div className="text-center text-gray-500 py-8">{t('session.noMessages')}</div>
          )}
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-4 mt-4">
            <button disabled={page === 0} onClick={() => setPage((p) => p - 1)} className="text-sm px-3 py-1 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-40">{t('common.previous')}</button>
            <span className="text-sm text-gray-500">{page + 1} / {totalPages}</span>
            <button disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)} className="text-sm px-3 py-1 rounded bg-gray-800 text-gray-300 hover:bg-gray-700 disabled:opacity-40">{t('common.next')}</button>
          </div>
        )}
      </div>
    </div>
  )
}

function InfoCard({ label, value, valueClass = 'text-white' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-sm font-medium truncate ${valueClass}`}>{value}</div>
    </div>
  )
}
