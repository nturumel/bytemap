import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { runScan } from './scanners'
import { performDeletions, performHelperDeletions } from './actions'
import { ctlPath, helperStatus, registerHelper } from './privilegedHelper'
import { refreshFullDiskAccess } from './scanners/usageDb'
import { cancelDirBreakdown, dirBreakdownStream, disposeScannerRuntime } from './scanner'
import { auxiliariesOutsideRoot, defaultCleanupWatchRoots, diskWatchService } from './diskWatch'
import type { DeleteRequest } from '@shared/types'
import { getVolumeStats } from './volumeStats'
import { AgentGrpcRuntimeClient } from './agentGrpcClient'
import type { BytemapAgentRequest } from '@shared/types'

const FULL_DISK_ACCESS_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  const cacheDbPath = join(app.getPath('userData'), 'scan-cache.db')
  const agentRuntime = new AgentGrpcRuntimeClient({
    helperCtlPath: ctlPath,
    helperStatus,
    refreshFullDiskAccess,
    sendEvent: (payload) => {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send('agent:event', payload)
    }
  })

  ipcMain.handle('scan:start', async () => {
    const start = Date.now()
    console.log('[scan] started')
    await runScan(
      {
        onProgress: (category, message) => {
          mainWindow.webContents.send('scan:progress', { category, message })
        },
        onItem: (item) => {
          mainWindow.webContents.send('scan:item', item)
        },
        onCategoryDone: (category) => {
          console.log(`[scan] ${category} done at +${Date.now() - start}ms`)
          mainWindow.webContents.send('scan:category-done', { category })
        }
      },
      cacheDbPath
    )
    console.log(`[scan] complete in ${Date.now() - start}ms`)
    return { durationMs: Date.now() - start }
  })

  ipcMain.handle('delete:items', async (_event, request: DeleteRequest) => {
    return performDeletions(request.items)
  })

  ipcMain.handle('delete:helperItems', async (_event, request: DeleteRequest) => {
    return performHelperDeletions(request.items)
  })

  ipcMain.handle('helper:status', () => helperStatus())

  ipcMain.handle('helper:register', () => registerHelper())
  ipcMain.handle('agent:providers', () => agentRuntime.providers())

  ipcMain.handle('agent:loginProvider', (_event, providerId: string) =>
    agentRuntime.loginProvider(providerId)
  )

  ipcMain.handle('agent:setProviderApiKey', (_event, providerId: string, apiKey: string) =>
    agentRuntime.setProviderApiKey(providerId, apiKey)
  )

  ipcMain.handle('agent:logoutProvider', (_event, providerId: string) =>
    agentRuntime.logoutProvider(providerId)
  )

  ipcMain.handle('agent:selectModel', (_event, modelId: string) =>
    agentRuntime.selectModel(modelId)
  )

  ipcMain.handle('agent:ask', (_event, request: BytemapAgentRequest) => agentRuntime.ask(request))

  ipcMain.handle('agent:reset', (_event, sessionId: string) => agentRuntime.reset(sessionId))

  ipcMain.handle('agent:cancel', (_event, requestId: string, sessionId: string) =>
    agentRuntime.cancel(requestId, sessionId)
  )

  mainWindow.on('closed', () => {
    void agentRuntime.disposeAll()
    void disposeScannerRuntime()
  })

  // Keep the renderer view isolated from superseded requests, while also cancelling the
  // corresponding Rust operation instead of allowing it to keep traversing in the background.
  let latestBreakdownRequest = 0
  let activeBreakdownRequestId: string | null = null

  diskWatchService.refreshQuietPrefixes()
  diskWatchService.setListener((payload) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('disk:changed', payload)
    }
  })

  ipcMain.handle('disk:breakdown', async (_event, path: string | null) => {
    const requestId = ++latestBreakdownRequest
    const scannerRequestId = randomUUID()
    const priorRequestId = activeBreakdownRequestId
    activeBreakdownRequestId = scannerRequestId
    if (priorRequestId) {
      void cancelDirBreakdown(priorRequestId).catch((error: unknown) =>
        console.warn('[scanner] failed to cancel superseded breakdown', error)
      )
    }

    const target = path ?? app.getPath('home')
    diskWatchService.beginBreakdown(target)
    try {
      await dirBreakdownStream(
        target,
        1,
        (node) => {
          if (requestId !== latestBreakdownRequest) return
          mainWindow.webContents.send('disk:breakdown-child', node)
        },
        scannerRequestId
      )
    } finally {
      if (activeBreakdownRequestId === scannerRequestId) activeBreakdownRequestId = null
      // Always pair beginBreakdown (including superseded requests) so the global gate closes.
      diskWatchService.endBreakdown(target)
    }
  })

  // Cache-hit navigations (e.g. breadcrumb back) never call breakdown, so cancel the actual
  // sidecar operation as well as filtering any in-flight node event at the renderer boundary.
  ipcMain.handle('disk:cancelBreakdown', () => {
    latestBreakdownRequest++
    const requestId = activeBreakdownRequestId
    activeBreakdownRequestId = null
    if (requestId) {
      void cancelDirBreakdown(requestId).catch((error: unknown) =>
        console.warn('[scanner] failed to cancel breakdown', error)
      )
    }
  })

  ipcMain.handle('disk:watch', (_event, path: string | null) => {
    const visualRoot = path ?? app.getPath('home')
    // Watch the current visualized root plus high-signal cleanup roots that are
    // *not* already covered by a recursive watch on visualRoot (avoids duplicate
    // FSEvents under home → Library/Caches while viewing home).
    const auxiliaries = auxiliariesOutsideRoot(
      visualRoot,
      defaultCleanupWatchRoots().filter((p) => existsSync(p))
    )
    diskWatchService.setWatchedRoots([visualRoot, ...auxiliaries])
  })

  ipcMain.handle('disk:unwatch', () => {
    diskWatchService.stopAll()
  })

  ipcMain.handle('disk:expectChanges', (_event, paths: string[]) => {
    diskWatchService.expectChanges(paths)
  })

  ipcMain.handle('disk:getVolumeStats', (_event, path?: string) => getVolumeStats(path ?? '/'))

  ipcMain.handle('shell:showItemInFolder', (_event, targetPath: string) => {
    shell.showItemInFolder(targetPath)
  })

  ipcMain.handle('shell:openPath', async (_event, targetPath: string) => {
    return shell.openPath(targetPath)
  })

  ipcMain.handle('system:fullDiskAccess', () => refreshFullDiskAccess())

  ipcMain.handle('system:openFullDiskAccessSettings', () => {
    shell.openExternal(FULL_DISK_ACCESS_SETTINGS_URL)
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Re-check when the window regains focus so returning from System Settings updates the UI.
  mainWindow.on('focus', () => {
    refreshFullDiskAccess().then((granted) => {
      mainWindow.webContents.send('system:fullDiskAccessChanged', granted)
    })
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.niharturumella.bytemap')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  void disposeScannerRuntime()
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  diskWatchService.stopAll()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
