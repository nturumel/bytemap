import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeleteResult, PrivilegedHelperState, ScanCategoryId, ScanItem } from '@shared/types'
import { HELPER_REQUIRED, SCAN_CATEGORIES } from '@shared/types'

export type Phase = 'intro' | 'scanning' | 'results' | 'deleting' | 'done'

function emptyMessages(): Record<ScanCategoryId, string> {
  const record = {} as Record<ScanCategoryId, string>
  for (const c of SCAN_CATEGORIES) record[c.id] = ''
  return record
}

function isIrreversible(item: ScanItem): boolean {
  return item.action?.kind === 'remove' || item.action?.kind === 'dockerPrune'
}

export interface UseScanState {
  phase: Phase
  items: ScanItem[]
  selected: Set<string>
  categoriesDone: Set<ScanCategoryId>
  messages: Record<ScanCategoryId, string>
  deleteResults: DeleteResult[] | null
  freedBytes: number
  hadIrreversibleActions: boolean
  helperState: PrivilegedHelperState | null
  helperPrompt: { items: ScanItem[] } | null
  helperInstalling: boolean
  helperError: string | null
  startScan: () => void
  toggleItem: (id: string) => void
  toggleCategory: (category: ScanCategoryId, checked: boolean) => void
  deleteSelected: () => Promise<void>
  installHelperAndRetry: () => Promise<void>
  skipHelperItems: () => void
  reset: () => void
  backToResults: () => void
}

export function useScan(): UseScanState {
  const [phase, setPhase] = useState<Phase>('intro')
  const [items, setItems] = useState<ScanItem[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [categoriesDone, setCategoriesDone] = useState<Set<ScanCategoryId>>(new Set())
  const [messages, setMessages] = useState<Record<ScanCategoryId, string>>(emptyMessages)
  const [deleteResults, setDeleteResults] = useState<DeleteResult[] | null>(null)
  const [freedBytes, setFreedBytes] = useState(0)
  const [hadIrreversibleActions, setHadIrreversibleActions] = useState(false)
  const [helperState, setHelperState] = useState<PrivilegedHelperState | null>(null)
  const [helperPrompt, setHelperPrompt] = useState<{ items: ScanItem[] } | null>(null)
  const [helperInstalling, setHelperInstalling] = useState(false)
  const [helperError, setHelperError] = useState<string | null>(null)
  const itemsRef = useRef<ScanItem[]>([])
  const pendingResultsRef = useRef<DeleteResult[]>([])

  useEffect(() => {
    const offProgress = window.api.scan.onProgress(({ category, message }) =>
      setMessages((prev) => ({ ...prev, [category]: message }))
    )
    const offItem = window.api.scan.onItem((item) => {
      itemsRef.current = [...itemsRef.current, item]
      setItems(itemsRef.current)
    })
    const offCategoryDone = window.api.scan.onCategoryDone(({ category }) => {
      setCategoriesDone((prev) => new Set(prev).add(category))
    })
    window.api.helper.status().then(setHelperState).catch(() => {
      setHelperState({ status: 'unavailable', ctlAvailable: false })
    })
    return () => {
      offProgress()
      offItem()
      offCategoryDone()
    }
  }, [])

  const applySuccessfulDeletes = useCallback((toDelete: ScanItem[], results: DeleteResult[]) => {
    const okIds = new Set(results.filter((r) => r.ok).map((r) => r.id))
    setFreedBytes((prev) => {
      const newlyFreed = toDelete
        .filter((i) => okIds.has(i.id))
        .reduce((sum, i) => sum + i.sizeBytes, 0)
      return prev + newlyFreed
    })
    itemsRef.current = itemsRef.current.filter((i) => !okIds.has(i.id))
    setItems(itemsRef.current)
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of okIds) next.delete(id)
      return next
    })
  }, [])

  const finishDelete = useCallback((results: DeleteResult[]) => {
    setDeleteResults(results)
    setHelperPrompt(null)
    setHelperError(null)
    setPhase('done')
  }, [])

  const startScan = useCallback(() => {
    itemsRef.current = []
    setItems([])
    setSelected(new Set())
    setCategoriesDone(new Set())
    setDeleteResults(null)
    setMessages(emptyMessages())
    setFreedBytes(0)
    setHelperPrompt(null)
    setHelperError(null)
    setPhase('scanning')
    window.api.helper.status().then(setHelperState).catch(() => undefined)
    window.api.scan.start().then(() => setPhase('results'))
  }, [])

  const toggleItem = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleCategory = useCallback((category: ScanCategoryId, checked: boolean) => {
    const ids = itemsRef.current.filter((i) => i.category === category).map((i) => i.id)
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }, [])

  const deleteSelected = useCallback(async () => {
    setPhase('deleting')
    setHelperError(null)
    setFreedBytes(0)
    const toDelete = itemsRef.current.filter((i) => selected.has(i.id))
    setHadIrreversibleActions(toDelete.some(isIrreversible))
    const results = await window.api.deleteItems({
      items: toDelete.map((i) => ({ id: i.id, path: i.path, action: i.action }))
    })

    const needsHelperIds = new Set(
      results.filter((r) => !r.ok && r.error === HELPER_REQUIRED).map((r) => r.id)
    )
    const settled = results.filter((r) => r.ok || r.error !== HELPER_REQUIRED)
    applySuccessfulDeletes(toDelete, settled)
    pendingResultsRef.current = settled

    if (needsHelperIds.size > 0) {
      const pendingItems = toDelete.filter((i) => needsHelperIds.has(i.id))
      setHelperPrompt({ items: pendingItems })
      setPhase('results')
      return
    }

    finishDelete(results)
  }, [selected, applySuccessfulDeletes, finishDelete])

  const installHelperAndRetry = useCallback(async () => {
    if (!helperPrompt) return
    setHelperInstalling(true)
    setHelperError(null)
    try {
      const state = await window.api.helper.register()
      setHelperState(state)
      if (state.status !== 'enabled') {
        setHelperError(
          state.status === 'requiresApproval'
            ? 'Approve Bytemap in System Settings → General → Login Items & Extensions, then try again.'
            : 'Helper did not become enabled. Try building a signed Bytemap.app.'
        )
        setHelperInstalling(false)
        return
      }

      setPhase('deleting')
      const pending = helperPrompt.items
      const helperResults = await window.api.deleteHelperItems({
        items: pending.map((i) => ({ id: i.id, path: i.path, action: i.action }))
      })
      applySuccessfulDeletes(pending, helperResults)
      const merged = [...pendingResultsRef.current, ...helperResults]
      setHelperInstalling(false)
      finishDelete(merged)
    } catch (err) {
      setHelperInstalling(false)
      setHelperError(err instanceof Error ? err.message : String(err))
    }
  }, [helperPrompt, applySuccessfulDeletes, finishDelete])

  const skipHelperItems = useCallback(() => {
    if (!helperPrompt) {
      finishDelete(pendingResultsRef.current)
      return
    }
    const skipped: DeleteResult[] = helperPrompt.items.map((item) => ({
      id: item.id,
      path: item.path,
      ok: false,
      error: 'Skipped — protected-file helper not installed'
    }))
    finishDelete([...pendingResultsRef.current, ...skipped])
  }, [helperPrompt, finishDelete])

  const reset = useCallback(() => {
    setPhase('intro')
    setDeleteResults(null)
    setHelperPrompt(null)
    setHelperError(null)
  }, [])

  const backToResults = useCallback(() => {
    setPhase('results')
    setDeleteResults(null)
    setHelperPrompt(null)
    setHelperError(null)
  }, [])

  return {
    phase,
    items,
    selected,
    categoriesDone,
    messages,
    deleteResults,
    freedBytes,
    hadIrreversibleActions,
    helperState,
    helperPrompt,
    helperInstalling,
    helperError,
    startScan,
    toggleItem,
    toggleCategory,
    deleteSelected,
    installHelperAndRetry,
    skipHelperItems,
    reset,
    backToResults
  }
}

export { SCAN_CATEGORIES }
