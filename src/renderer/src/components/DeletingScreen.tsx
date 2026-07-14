import { SpinnerIcon } from './icons'

export function DeletingScreen(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center">
      <SpinnerIcon width={28} height={28} className="text-blue-500" />
      <h1 className="mt-5 text-xl font-semibold">Moving to Trash…</h1>
    </div>
  )
}
