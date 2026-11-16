/**
 * Vektra Caja — aplicación de escritorio (Electron).
 * Arranca el motor local (SQLite + API local en 127.0.0.1) y abre el punto de venta. Las ventas se
 * guardan en la computadora y se sincronizan solas con el servidor de la empresa.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { createLocalEngine, type LocalEngine } from '@vektra/pos-local';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

/** Puertos fijos: el origen de la página no cambia entre reinicios (preferencias del navegador). */
const PORTS = [47800, 47801, 47802, 47803, 47804, 47805];

let engine: LocalEngine | null = null;
let win: BrowserWindow | null = null;
let baseUrl = '';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(start).catch((e) => {
    dialog.showErrorBox('Vektra Caja', `No se pudo iniciar la caja:\n\n${(e as Error).message}`);
    app.quit();
  });
}

function webRoot(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'web');
  // Desarrollo: dist/apps/desktop/app/main.js → dist/apps/web/browser
  return resolve(__dirname, '../../web/browser');
}

async function start(): Promise<void> {
  const dataDir = app.getPath('userData');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const fingerprint = createHash('sha256').update(`${hostname()}|${userInfo().username}|${dataDir}`).digest('hex').slice(0, 40);

  engine = createLocalEngine({ dbPath: join(dataDir, 'caja.sqlite'), webRoot: webRoot(), appVersion: app.getVersion(), fingerprint });
  let port = 0;
  for (const p of PORTS) {
    try {
      port = await engine.start(p);
      break;
    } catch {
      /* puerto ocupado: probar el siguiente */
    }
  }
  if (!port) port = await engine.start(0);
  baseUrl = `http://127.0.0.1:${port}`;

  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1366,
    height: 820,
    minWidth: 360,
    minHeight: 560,
    show: false,
    title: 'Vektra Caja',
    backgroundColor: '#f4f7f7',
    autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.once('ready-to-show', () => {
    win?.maximize();
    win?.show();
  });
  // Enlaces externos (WhatsApp, RIDE, SRI) se abren en el navegador del sistema.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(baseUrl)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (ev, url) => {
    if (!url.startsWith(baseUrl)) {
      ev.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') win?.setFullScreen(!win.isFullScreen());
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i' && !app.isPackaged) win?.webContents.toggleDevTools();
  });
  await win.loadURL(`${baseUrl}/pos`);
}

// ───────── Impresión directa (sin diálogo) ─────────

ipcMain.handle('vk:printers', async () => {
  if (!win) return [];
  const list = await win.webContents.getPrintersAsync();
  return list.map((p) => ({ name: p.name, displayName: p.displayName, isDefault: !!(p as { isDefault?: boolean }).isDefault }));
});

ipcMain.handle('vk:print', async (_e, html: string, opts: { printerName?: string | null; widthMm: number }) => {
  if (typeof html !== 'string' || html.length > 3_000_000) throw new Error('Documento de impresión inválido');
  const widthMm = opts?.widthMm === 58 ? 58 : 80;
  const pw = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, javascript: true } });
  try {
    await pw.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    // Alto real del ticket para no cortar ni desperdiciar papel en el rollo
    const heightPx: number = await pw.webContents.executeJavaScript(
      'Promise.all(Array.from(document.images).map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))).then(() => document.documentElement.scrollHeight)',
    );
    const heightMicrons = Math.max(50_000, Math.ceil(((heightPx * 25.4) / 96) * 1000) + 8_000);
    await new Promise<void>((ok, fail) =>
      pw.webContents.print(
        {
          silent: true,
          printBackground: true,
          deviceName: opts?.printerName || undefined,
          margins: { marginType: 'none' },
          pageSize: { width: widthMm * 1000, height: heightMicrons },
        },
        (success, reason) => (success ? ok() : fail(new Error(reason === 'cancelled' ? 'Impresión cancelada' : `No se pudo imprimir: ${reason}`))),
      ),
    );
  } finally {
    pw.destroy();
  }
});

ipcMain.handle('vk:version', () => app.getVersion());

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  void engine?.stop();
  engine = null;
});
