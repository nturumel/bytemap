import { useEffect, useRef } from 'react'
import { WarningIcon } from './icons'

export function HelperInstallModal({
  pendingCount,
  installing,
  error,
  onInstall,
  onSkip
}: {
  pendingCount: number
  installing: boolean
  error: string | null
  onInstall: () => void
  onSkip: () => void
}): React.JSX.Element {
  const onSkipRef = useRef(onSkip)
  const installingRef = useRef(installing)
  const skipButtonRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    onSkipRef.current = onSkip
  }, [onSkip])

  useEffect(() => {
    installingRef.current = installing
  }, [installing])

  useEffect(() => {
    skipButtonRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (installingRef.current) return
      e.preventDefault()
      e.stopPropagation()
      onSkipRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div
      className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-6"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !installing) onSkip()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="helper-install-title"
        className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl dark:bg-neutral-900"
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-500/10 text-blue-500">
            <WarningIcon width={18} height={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="helper-install-title" className="text-sm font-semibold">
              Allow Bytemap to clean protected files?
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
              {pendingCount} item{pendingCount === 1 ? '' : 's'} need admin rights once. Installing
              Bytemap’s protected-file helper asks for your password a single time; later cleans of
              those paths will not prompt again.
            </p>
            {error && (
              <p className="mt-2 text-xs text-red-500 dark:text-red-400">{error}</p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                ref={skipButtonRef}
                type="button"
                disabled={installing}
                onClick={onSkip}
                className="rounded-full px-4 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                Skip these
              </button>
              <button
                type="button"
                disabled={installing}
                onClick={onInstall}
                className="rounded-full bg-blue-500 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-600 active:scale-[0.98] disabled:opacity-50"
              >
                {installing ? 'Installing…' : 'Install helper'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
