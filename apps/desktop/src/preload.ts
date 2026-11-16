/**
 * Puente mínimo entre la página y el proceso principal: solo impresión directa.
 * Todo lo demás (ventas, caja, sincronización) pasa por la API local en 127.0.0.1.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('vektraDesktop', {
  version: process.env['npm_package_version'] ?? '',
  printers: () => ipcRenderer.invoke('vk:printers'),
  print: (html: string, opts: { printerName?: string | null; widthMm: number }) => ipcRenderer.invoke('vk:print', html, opts),
});
