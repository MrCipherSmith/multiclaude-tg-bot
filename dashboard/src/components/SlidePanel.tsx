import { useEffect, useRef } from 'react'

interface SlidePanelProps {
  open: boolean
  onClose: () => void
  title?: string
  children: React.ReactNode
  width?: string
}

export function SlidePanel({ open, onClose, title, children, width = 'max-w-lg' }: SlidePanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        ref={panelRef}
        className={`relative ${width} w-full bg-gray-900 border-l border-gray-700 shadow-2xl flex flex-col animate-slide-in`}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          {title && <h2 className="text-sm font-medium text-white">{title}</h2>}
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg ml-auto">&times;</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {children}
        </div>
      </div>
    </div>
  )
}
