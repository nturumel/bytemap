# Bytemap

Find what's eating your Mac's disk space, review it, and clean it up — with a live treemap of where the bytes actually went.

## Features

- Scans unused apps, duplicates, large files, regenerable caches/logs, and old downloads
- Prefers moving items to Trash; permanently removes regenerable caches (CCleaner-style)
- For paths that need admin rights, installs a **one-time privileged helper** (`SMAppService`) so later cleans do not re-prompt
- Optional Full Disk Access improves unused-app last-used accuracy

## Development

```bash
npm install
npm run dev
```

Requires macOS 13+ for the privileged helper APIs. In unsigned Electron-dev runs, user-writable deletes still work; helper registration needs a signed/packed `Bytemap.app` (`npm run build:mac`).

Build the Swift helper alone:

```bash
npm run build:helper
```

## Build

```bash
npm run build:mac
```

## License

Private / unpublished unless you add a LICENSE.
