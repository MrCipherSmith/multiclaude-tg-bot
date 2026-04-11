import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Bot } from 'lucide-react'
import { api, type TelegramLoginData } from '../api/client'
import { useI18n } from '../i18n'

export function LoginPage() {
  const navigate = useNavigate()
  const widgetRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const { t } = useI18n()

  useEffect(() => {
    ;(window as any).onTelegramAuth = async (user: TelegramLoginData) => {
      try {
        setError(null)
        await api.authTelegram(user)
        navigate({ to: '/' })
      } catch (e: any) {
        setError(e.message || t('login.error'))
      }
    }

    const script = document.createElement('script')
    script.src = 'https://telegram.org/js/telegram-widget.js?22'
    script.setAttribute('data-telegram-login', import.meta.env.VITE_TELEGRAM_BOT_NAME)
    script.setAttribute('data-size', 'large')
    script.setAttribute('data-radius', '8')
    script.setAttribute('data-onauth', 'onTelegramAuth(user)')
    script.async = true
    widgetRef.current?.appendChild(script)

    return () => { delete (window as any).onTelegramAuth }
  }, [navigate, t])

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950">
      {/* Background decoration */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-indigo-500/5 rounded-full blur-[120px]" />
        <div className="absolute bottom-1/4 left-1/3 w-[400px] h-[400px] bg-violet-500/5 rounded-full blur-[100px]" />
      </div>

      <div className="relative max-w-sm w-full mx-4">
        {/* Logo */}
        <div className="flex justify-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-xl shadow-indigo-500/20">
            <Bot className="w-8 h-8 text-white" />
          </div>
        </div>

        {/* Card */}
        <div className="card-glow bg-gray-900/80 backdrop-blur-xl rounded-2xl p-8 border border-gray-800/50 shadow-2xl">
          <h1 className="text-xl font-bold text-white text-center mb-1">{t('login.title')}</h1>
          <p className="text-gray-500 text-center text-sm mb-8">{t('login.subtitle')}</p>

          <div ref={widgetRef} className="flex justify-center mb-4" />

          {error && (
            <div className="mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm text-center">
              {error}
            </div>
          )}

          <p className="mt-8 text-gray-700 text-xs text-center">{t('login.notice')}</p>
        </div>
      </div>
    </div>
  )
}
