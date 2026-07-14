import { useEffect, useState } from 'react'

const DISMISSED_KEY = 'fullDiskAccessBannerDismissed'

export function FullDiskAccessBanner(): React.JSX.Element | null {
  const [granted, setGranted] = useState<boolean | null>(null)
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED_KEY) === '1')

  useEffect(() => {
    window.api.system.checkFullDiskAccess().then(setGranted)
    return window.api.system.onFullDiskAccessChanged(setGranted)
  }, [])

  if (granted !== false || dismissed) return null

  const dismiss = (): void => {
    localStorage.setItem(DISMISSED_KEY, '1')
    setDismissed(true)
  }

  return (
    <div className="mt-6 flex max-w-md items-center gap-2 text-left">
      <p className="flex-1 text-xs text-neutral-400 dark:text-neutral-500">
        Tip: unused-app detection is more accurate with{' '}
        <button
          onClick={() => window.api.system.openFullDiskAccessSettings()}
          className="no-drag font-medium text-blue-500 underline-offset-2 hover:underline dark:text-blue-400"
        >
          Full Disk Access
        </button>{' '}
        — optional, not required.
      </p>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="no-drag shrink-0 rounded-full p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:text-neutral-600 dark:hover:bg-neutral-900 dark:hover:text-neutral-300"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}
