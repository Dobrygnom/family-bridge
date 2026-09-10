const { app, crashReporter, BrowserWindow } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const directory = process.argv[2], mode = process.argv[3];
if (!path.basename(directory || '').startsWith('fb-crash-smoke-') || !['main','renderer'].includes(mode)) throw Error('Isolated test directory and mode required');
app.setPath('userData', directory);
(async () => {
  const { installCrashDiagnostics } = await import(pathToFileURL(path.resolve(__dirname, '../dist-electron/electron/crash-diagnostics.js')));
  installCrashDiagnostics(app, { start: options => crashReporter.start({ ...options, ignoreSystemCrashHandler: true }), getUploadToServer: () => crashReporter.getUploadToServer() }, { record: () => {} }, () => false);
  await app.whenReady();
  if (mode === 'main') return setTimeout(() => process.crash(), 500);
  const window = new BrowserWindow({show:false,webPreferences:{sandbox:true}});
  window.webContents.once('render-process-gone', () => setTimeout(() => app.quit(), 500));
  await window.loadURL('data:text/html,<title>Isolated crash capture test</title>');
  window.webContents.forcefullyCrashRenderer();
})().catch(() => app.exit(2));
