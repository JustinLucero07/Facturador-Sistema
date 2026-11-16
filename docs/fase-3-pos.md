# Fase 3 — Punto de venta web (caja, cobro, factura electrónica, ticket)

## Qué hay

| Pieza | Dónde |
|---|---|
| Pantalla de caja a pantalla completa (`/pos`), táctil y con teclado/lector de códigos | `apps/web/src/app/pages/pos/pos.ts` |
| Apertura de caja con fondo inicial, ingresos/egresos con motivo, corte parcial, arqueo y cierre | `apps/api/src/app/pos/cash.service.ts`, `pages/pos/cash-dialogs.ts` |
| Cobro con varios medios en una venta (efectivo con vuelto, tarjetas, transferencia, Deuna, Payphone, crédito) | `pages/pos/payment-dialog.ts` |
| La venta emite la **factura electrónica** con el mismo flujo de la Fase 1 (firma → cola → SRI) y descuenta stock | `libs/einvoice/src/lib/issue.ts` |
| Ticket térmico 58/80 mm con clave de acceso y QR al RIDE | `pages/pos/ticket-printer.ts` |
| Envío por correo (SMTP de la empresa) y por WhatsApp (`wa.me` con enlace firmado al RIDE) | `pages/pos/sale-done-dialog.ts`, `apps/api/src/app/pos/public-link.ts` |
| Proformas: guardar el carrito, abrirlo después y facturarlo (una sola vez) | `POST/GET /api/quotes` |
| Descuento por línea y descuento global repartido entre líneas (con permiso `sales.discount`) | `distributeDiscount` en `@vektra/sri-core/calc` |

## Reglas

- **No se vende sin caja abierta.** Una sola caja abierta por punto de emisión (índice único parcial en BD). La factura queda ligada a la sesión de caja.
- **El código SRI de la forma de pago lo decide el servidor** (parámetro `payment_methods`, Tabla 24), no la pantalla. Por defecto: efectivo/crédito 01, débito 16, crédito/Payphone 19, transferencia/Deuna 20. *Pendiente confirmar Deuna y Payphone con el contador.*
- **Crédito** solo con cliente identificado (no consumidor final).
- **Consumidor final:** el tope (hoy $50) se lee de la BD; si se supera, la pantalla pide identificar al cliente.
- **Arqueo:** efectivo esperado = fondo inicial + ventas cobradas en efectivo (ya sin el vuelto) + ingresos − egresos. La diferencia (sobrante/faltante) queda registrada y auditada; la caja cerrada ya no admite ventas.
- **Precios:** la pantalla muestra PVP con IVA; al editar el PVP se guarda el precio sin IVA (6 decimales) y el SRI recalcula. El descuento global se reparte en proporción al valor de cada línea; el residuo de centavos va a las de mayor valor.
- Al cambiar el cliente se reaplican los precios de su lista (Público/Mayorista/Distribuidor).
- Preferencias de la estación (punto de emisión, papel 58/80 mm, impresión automática) se guardan en el navegador de esa caja.

## Atajos de teclado

| Tecla | Acción |
|---|---|
| F2 | Buscar / escanear producto |
| F4 | Cliente |
| F8 | Descuento global (`5` = $5, `10%` = porcentaje) |
| F12 | Cobrar |
| Enter | Editar la línea seleccionada · en el cobro: facturar · al terminar: nueva venta |
| + / − / Supr | Cantidad de la línea seleccionada / quitarla |
| ↑ / ↓ | Moverse entre líneas |
| Esc | Vaciar la venta |
| P | Reimprimir el ticket (en la pantalla de venta registrada) |

En el diálogo de cobro el monto sugerido aparece seleccionado: teclear reemplaza (p. ej. escribir `50` para un billete de $50).

## Pruebas

- `apps/api/test/pos.e2e-spec.ts` (10 casos): sin caja no se vende, una caja por punto, vuelto, pago mixto con código 19, crédito exige cliente, arqueo con egresos, cierre con faltante, permiso de descuento, proforma facturada una sola vez, enlace público firmado.
- `libs/sri-core/src/lib/calc.spec.ts`: reparto del descuento global.
- Prueba en navegador (Chromium automatizado, SRI simulado): venta de 3 productos con IVA 15 % y 5 % desde el primer escaneo hasta "Venta registrada" en **~2,3 s** (criterio: < 15 s). Las facturas quedaron **AUTORIZADAS** por el worker. Probado también: edición con teclado, descuento 10 %, proforma → factura, pago efectivo + tarjeta, arqueo, ticket de 80 mm y vista móvil (390 px).

## Pendiente para fases siguientes

- Caja de escritorio **sin internet** (Electron + SQLite, secuenciales offline) → Fase 4.
- Notas de crédito y devoluciones desde la caja → Fase 5.
- Cuentas por cobrar de las ventas a crédito → Fase 6.
- Cobro por API de Deuna/Payphone y WhatsApp Business API (hoy: registro manual y `wa.me`).
- Impresión directa sin diálogo del navegador (ESC/POS) → llega con la app de escritorio (Fase 4).
