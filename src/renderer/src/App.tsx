import { useMemo, useState } from 'react'
import { useScan } from './hooks/useScan'
import { IntroScreen } from './components/IntroScreen'
import { ScanningScreen } from './components/ScanningScreen'
import { ResultsScreen } from './components/ResultsScreen'
import { DeletingScreen } from './components/DeletingScreen'
import { DoneScreen } from './components/DoneScreen'
import { DiskUsageScreen } from './components/DiskUsageScreen'
import { HelperInstallModal } from './components/HelperInstallModal'
import { AgentChatWidget } from './components/AgentChatWidget'
import { buildFreeChatAgentContext, buildGlobalScanAgentContext } from './lib/agentContext'

type View = 'cleanup' | 'diskUsage'

function App(): React.JSX.Element {
  const scan = useScan()
  const [view, setView] = useState<View>('cleanup')
  const agentContext = useMemo(
    () =>
      scan.phase === 'intro'
        ? buildFreeChatAgentContext()
        : buildGlobalScanAgentContext({
            phase: scan.phase,
            items: scan.items,
            selectedIds: scan.selected
          }),
    [scan.phase, scan.items, scan.selected]
  )

  if (view === 'diskUsage') {
    return (
      <div className="h-screen w-screen overflow-hidden">
        <DiskUsageScreen onBack={() => setView('cleanup')} />
      </div>
    )
  }

  return (
    <div className="h-screen w-screen overflow-hidden">
      {scan.phase === 'intro' && (
        <IntroScreen onStart={scan.startScan} onShowDiskUsage={() => setView('diskUsage')} />
      )}

      {scan.phase === 'scanning' && (
        <ScanningScreen
          messages={scan.messages}
          categoriesDone={scan.categoriesDone}
          items={scan.items}
        />
      )}

      {scan.phase === 'results' && (
        <ResultsScreen
          items={scan.items}
          selected={scan.selected}
          helperState={scan.helperState}
          onToggleItem={scan.toggleItem}
          onToggleCategory={scan.toggleCategory}
          onConfirmDelete={scan.deleteSelected}
          onRescan={scan.startScan}
          onShowDiskUsage={() => setView('diskUsage')}
        />
      )}

      {scan.phase === 'deleting' && <DeletingScreen />}

      {scan.helperPrompt && (
        <HelperInstallModal
          pendingCount={scan.helperPrompt.items.length}
          installing={scan.helperInstalling}
          error={scan.helperError}
          onInstall={() => {
            void scan.installHelperAndRetry()
          }}
          onSkip={scan.skipHelperItems}
        />
      )}

      {scan.phase === 'done' && scan.deleteResults && (
        <DoneScreen
          results={scan.deleteResults}
          freedBytes={scan.freedBytes}
          hadIrreversibleActions={scan.hadIrreversibleActions}
          onRescan={scan.startScan}
          onBackToResults={scan.backToResults}
        />
      )}

      <AgentChatWidget context={agentContext} />
    </div>
  )
}

export default App
