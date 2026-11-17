# Fase 4 — Caja de escritorio sin internet (Vektra Caja)

## Qué hay

| Pieza | Dónde |
|---|---|
| App de escritorio (Electron 45): abre el punto de venta a pantalla completa e imprime directo en la térmica | `apps/desktop` |
| Motor local: SQLite (`node:sqlite`, incluido en Electron), API local en `127.0.0.1`, sesiones, ventas, caja, proformas | `libs/pos-local` |
| Sincronización en segundo plano: cola de operaciones (push) + cambios del servidor (pull) | `libs/pos-local/src/lib/sync.ts` |
| Vincular y administrar cajas (código de un solo uso, estado, pendientes, revocar) | web: **Administración → Cajas de escritorio**; API `apps/api/src/app/devices` |
| Recepción de lo hecho sin conexión (idempotente) | `apps/api/src/app/sync` |
| Emisión de facturas sin conexión en el servidor (mismo id, secuencial, fecha y clave de acceso de la caja) | `libs/einvoice/src/lib/issue.ts` (`offline`) |
| Alta rápida de productos desde la caja (al escanear un código que no existe) | `POST /api/products/quick` (web y escritorio) |

Sin módulos nativos: SQLite viene con Electron y la verificación de contraseñas (argon2) es WebAssembly (`hash-wasm`). El ejecutable final pesa ~0,8 MB de código propio.

## Cómo funciona

1. En **Estructura** se crea un punto de emisión de tipo **Caja de escritorio** (p. ej. 001-002). Ese punto es exclusivo de una computadora: la web no puede facturar en él, así los secuenciales hechos sin conexión nunca chocan.
2. En **Cajas de escritorio → Nueva caja** se genera un **código de 10 caracteres** (vence en 30 min, un solo uso).
3. En la computadora: instalar *Vektra Caja*, escribir la dirección del servidor y el código. La caja descarga catálogo, precios, clientes, usuarios, parámetros y stock.
4. El cajero entra con su correo y clave de siempre (se verifica en la caja, sin internet).
5. Cada venta se guarda en la computadora con su **secuencial y clave de acceso** (el ticket ya sale completo). La factura queda *Pendiente de sincronizar*.
6. Cada 15 s (y al instante tras cada venta) la caja envía la cola en orden. El servidor genera el XML con esos mismos datos, lo **firma con el .p12 que nunca sale del servidor** y lo envía al SRI (flujo de la Fase 1). El estado (autorizada / no autorizada) vuelve a la caja.

## Reglas

- **Idempotencia:** cada operación lleva un id (uuidv7) generado en la caja; reenviarla no la aplica dos veces (tabla `sync_op`). Las facturas también se protegen por id y por (punto, secuencial).
- **Secuencial:** la caja usa el mayor entre su contador y el del servidor; el servidor deja su contador en `máximo usado + 1`.
- **Clave de acceso:** el servidor la recalcula con el código numérico de la caja y la compara; si no coincide (p. ej. cambió el ambiente mientras estaba sin conexión), la venta se rechaza y queda visible para el administrador.
- **Stock:** una venta sin conexión ya ocurrió: el servidor la registra aunque deje el stock negativo. En la caja, el disponible = stock del servidor − ventas aún no enviadas; si la empresa no permite stock negativo, la caja no vende más de lo disponible.
- **Producto creado en la caja con un código que ya existe en el servidor:** se rechaza el producto y sus ventas quedan como líneas libres (sin stock), sin perder la factura.
- **Clientes creados en la caja:** se fusionan por identificación; no se pisan lista de precios ni crédito del servidor.
- **Tiempo sin conexión:** la caja factura hasta `desktop.max_offline_hours` (48 h por defecto, parámetro en BD) desde la última sincronización; luego pide conectarse. También respeta la licencia y el certificado según el último estado recibido.
- **Arqueo:** se hace en la caja con la misma fórmula que el servidor; se envía tal cual y el servidor lo verifica con sus propios datos (prueba: ambos dan $132,00).
- **Revocar** una caja corta su sincronización de inmediato. **Nuevo código** sirve para cambiar de computadora (la anterior deja de sincronizar al vincularse la nueva).
- El enlace QR del ticket se firma en la caja con una llave derivada del servidor; si el cliente lo abre antes de que la venta llegue, ve "Su factura aún se está procesando".

## Pendiente de confirmar (no inventado)

- **Plazo para enviar al SRI un comprobante emitido sin conexión.** La Ficha Técnica v2.34 solo define el error 65 *"Fecha de emisión extemporánea"*, sin indicar el plazo. Quedó el parámetro `offline.send_deadline_hours` (vacío). **Confirmar con el contador** antes de producción.

## Construir e instalar

```bash
pnpm nx serve desktop          # desarrollo (usa dist/apps/web/browser)
pnpm nx package desktop        # instalador Linux (AppImage, deb) en dist/apps/desktop/release
pnpm nx package desktop -- --win nsis   # Windows: requiere wine en Linux, o usar el workflow
```

El instalador de Windows (`Vektra-Caja-Setup-x.y.z.exe`) se genera con el workflow **.github/workflows/desktop.yml** (ejecución manual en un runner de Windows). En esta máquina no hay `wine`, así que el `.exe` no se probó; sí se probó el AppImage de Linux empaquetado.

Datos de la caja: `%APPDATA%/vektra-caja/caja.sqlite` (Windows) o `~/.config/vektra-caja/caja.sqlite` (Linux).

## Pruebas

- `apps/api/test/desktop.e2e-spec.ts` (11 casos, motor local real + API real + Postgres): vinculación de un solo uso, ingreso sin conexión con la clave real, venta en línea, la web no factura en el punto de escritorio, **corte de red** (cliente y producto nuevos, numeración sin saltos, stock local), límite de 48 h, **reconexión** (mismas claves y números, stock del servidor coincide), **idempotencia** (reenvío sin duplicados), autorización del SRI devuelta a la caja, arqueo idéntico, revocación.
- Prueba manual con la app Electron real (Playwright): vincular → ingresar → abrir caja → venta de 3 productos en ~1,6 s → alta rápida por código de barras → **se apagó la API** → 2 ventas más sin conexión ("Sin conexión · 2 por enviar · quedan 47 h") → se encendió la API → sincronizó sola y las 3 facturas quedaron **AUTORIZADAS**.

## Pendiente para fases siguientes

- Notas de crédito / devoluciones desde la caja sin conexión → se agregan a esta misma cola en la Fase 5.
- Apertura del cajón de dinero (pulso ESC/POS) y actualización automática de la app.
- Instalador de Windows firmado (certificado de firma de código) para evitar el aviso de SmartScreen.
