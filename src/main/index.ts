import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { runScan } from './scanners'
import { performDeletions, performHelperDeletions } from './actions'
import { helperStatus, registerHelper } from './privilegedHelper'
import { refreshFullDiskAccess } from './scanners/usageDb'
import { dirBreakdownStream } from './native'
import type { DeleteRequest } from '@shared/types'

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

  // If the user drills into a new folder before the previous breakdown finishes streaming,
  // late-arriving nodes from the superseded request must not leak into the new view — the
  // Rust side has no cancellation, so filter by "is this still the latest request" here.
  let latestBreakdownRequest = 0
  ipcMain.handle('disk:breakdown', async (_event, path: string | null) => {
    const requestId = ++latestBreakdownRequest
    const target = path ?? app.getPath('home')
    await dirBreakdownStream(target, 1, (node) => {
      if (requestId !== latestBreakdownRequest) return
      mainWindow.webContents.send('disk:breakdown-child', node)
    })
  })

  // Cache-hit navigations (e.g. breadcrumb back) never call breakdown, so bump the request
  // id explicitly — otherwise an in-flight scan keeps streaming into the restored view.
  ipcMain.handle('disk:cancelBreakdown', () => {
    latestBreakdownRequest++
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

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
