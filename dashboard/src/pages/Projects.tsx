import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api, type Project } from '../api/client'
import { useI18n } from '../i18n'

export function ProjectsPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const [newName, setNewName] = useState('')
  const [newPath, setNewPath] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['projects'],
    queryFn: api.projects,
    refetchInterval: 10_000,
  })

  const startMutation = useMutation({
    mutationFn: (id: number) => api.startProject(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })

  const stopMutation = useMutation({
    mutationFn: (id: number) => api.stopProject(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteProject(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  })

  const createMutation = useMutation({
    mutationFn: (data: { name: string; path: string }) => api.createProject(data),
    onSuccess: () => {
      setNewName('')
      setNewPath('')
      setFormError(null)
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
    onError: (err: Error) => {
      setFormError(err.message)
    },
  })

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault()
    setFormError(null)
    if (!newName.trim() || !newPath.trim()) return
    createMutation.mutate({ name: newName.trim(), path: newPath.trim() })
  }

  const handleDelete = (project: Project) => {
    if (!confirm(t('projects.deleteConfirm').replace('{name}', project.name))) return
    deleteMutation.mutate(project.id)
  }

  if (isLoading) return <div className="text-gray-400">{t('common.loading')}</div>
  if (error) return <div className="text-red-400">{t('common.error')}: {(error as Error).message}</div>

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-white">{t('projects.title')}</h1>
        <button
          onClick={() => refetch()}
          className="text-sm text-gray-400 hover:text-white px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700"
        >
          {t('common.refresh')}
        </button>
      </div>

      {/* Add project form */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
        <h2 className="text-sm font-medium text-gray-300 mb-3">{t('projects.addTitle')}</h2>
        <form onSubmit={handleCreate} className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t('projects.namePlaceholder')}
            className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
          />
          <input
            type="text"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            placeholder={t('projects.pathPlaceholder')}
            className="flex-[2] bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            disabled={createMutation.isPending || !newName.trim() || !newPath.trim()}
            className="px-4 py-1.5 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-sm text-white font-medium transition-colors"
          >
            {createMutation.isPending ? t('projects.adding') : t('projects.addBtn')}
          </button>
        </form>
        {formError && <p className="mt-2 text-xs text-red-400">{formError}</p>}
      </div>

      {/* Projects table */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-800/50">
              <th className="text-left px-4 py-2 font-medium text-gray-400">{t('projects.name')}</th>
              <th className="text-left px-4 py-2 font-medium text-gray-400">{t('projects.path')}</th>
              <th className="text-left px-4 py-2 font-medium text-gray-400">{t('projects.status')}</th>
              <th className="text-left px-4 py-2 font-medium text-gray-400">{t('projects.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {(data ?? []).map((project) => {
              const isActive = project.session_status === 'active'
              return (
                <tr key={project.id} className="hover:bg-gray-800/30">
                  <td className="px-4 py-2 text-white font-medium">{project.name}</td>
                  <td className="px-4 py-2 text-gray-400 font-mono text-xs">{project.path}</td>
                  <td className="px-4 py-2">
                    <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full ${isActive ? 'bg-green-900/40 text-green-400' : 'bg-gray-800 text-gray-500'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${isActive ? 'bg-green-400' : 'bg-gray-600'}`} />
                      {isActive ? t('projects.active') : t('projects.inactive')}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      {!isActive ? (
                        <button
                          onClick={() => startMutation.mutate(project.id)}
                          disabled={startMutation.isPending}
                          className="text-xs px-2.5 py-1 rounded bg-green-900/40 text-green-400 hover:bg-green-900/70 disabled:opacity-50 transition-colors"
                        >
                          {t('projects.start')}
                        </button>
                      ) : (
                        <button
                          onClick={() => stopMutation.mutate(project.id)}
                          disabled={stopMutation.isPending}
                          className="text-xs px-2.5 py-1 rounded bg-yellow-900/40 text-yellow-400 hover:bg-yellow-900/70 disabled:opacity-50 transition-colors"
                        >
                          {t('projects.stop')}
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(project)}
                        disabled={deleteMutation.isPending || isActive}
                        className="text-xs px-2.5 py-1 rounded bg-red-900/40 text-red-400 hover:bg-red-900/70 disabled:opacity-50 transition-colors"
                      >
                        {t('projects.delete')}
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
            {(data?.length ?? 0) === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-gray-500">
                  {t('projects.noProjects')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
