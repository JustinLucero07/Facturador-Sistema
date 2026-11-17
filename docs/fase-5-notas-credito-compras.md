# Fase 5 — Notas de crédito, devoluciones y compras

## Qué hay

| Pieza | Dónde |
|---|---|
| Nota de crédito electrónica (comprobante 04, XML v1.1.0 del XSD oficial), firmada y enviada al SRI por la misma cola | `libs/einvoice/src/lib/credit-note.ts`, `libs/sri-core/src/lib/xml/credit-note.ts` |
| Cálculo de devoluciones (precio e IVA de la factura, descuento prorrateado, saldo exacto al final) | `creditLine` en `@vektra/sri-core/calc` |
| RIDE (PDF) y ticket térmico de la nota de crédito; correo con "Nota de crédito electrónica" | `libs/sri-core/src/lib/ride/ride.ts`, `apps/web/.../pos/ticket-printer.ts` |
| Devolución en la caja: **F9**, por número de factura o clave de acceso | `apps/web/.../pos/return-dialog.ts` |
| Nota de crédito desde el detalle del comprobante (web) | Facturación → Comprobantes → factura → **Nota de crédito** |
| Devolución **sin conexión** en la caja de escritorio (cola `credit_note.issue`) | `libs/pos-local/src/lib/credit-notes.ts` |
| Compras a proveedores: manual o cargando el **XML autorizado** del proveedor; anulación | Inventario → **Compras**; `apps/api/src/app/purchases` |

## Reglas (Ficha Técnica offline v2.34 y XSD oficial)

- **XSD:** `NotaCredito_V1.1.0.xsd` descargado del portal del SRI (zip "XML y XSD Nota de Crédito"); se valida antes de firmar. Lleva el mismo ajuste de la leyenda RIMPE Negocio Popular que la factura (ver `libs/sri-core/xsd/LEEME.md`).
- **Tarifa de IVA:** la de la fecha de la factura original (Ficha: *"La tarifa de IVA corresponderá a la fecha de emisión del documento de sustento"*). Se copian los impuestos de cada línea de la factura, no las tarifas actuales.
- **Receptor identificado:** la nota de crédito no admite consumidor final (Ficha, Tabla 6). Si la venta fue a consumidor final, la pantalla pide cédula/RUC/pasaporte y nombre.
- **Nunca más de lo facturado:** por cada línea se controla lo ya devuelto en notas vigentes (las no autorizadas o devueltas por el SRI no cuentan). El descuento se prorratea y la última devolución toma el saldo exacto: varias devoluciones parciales suman exactamente la factura (prueba unitaria).
- **No se acredita una factura que el SRI no autorizó.**
- **Stock:** la mercadería vuelve a la bodega del establecimiento de la venta **al costo con que salió en esa venta** (kárdex `SALE_RETURN`). Si se desmarca "Stock" (producto dañado), no reingresa.
- **Reembolso:** en efectivo con caja abierta se registra como **egreso de esa caja** (el arqueo cuadra solo); otros medios quedan anotados en la nota ("Reembolso: Transferencia").
- **Permiso:** `sales.void` ("Anular ventas / emitir notas de crédito"). El rol Cajero **no** lo tiene por defecto; el administrador puede agregárselo en Roles.
- **Caja de escritorio:** devuelve solo ventas hechas en esa caja (las de otras cajas, desde la web). Numera las notas en su propio punto de emisión (serie 04) y el servidor respeta el secuencial y la clave de acceso.

## Compras

- **Manual:** proveedor (si no existe se crea como proveedor), comprobante (factura, nota de venta, liquidación), número, autorización, fecha, bodega y líneas (producto, cantidad, costo sin IVA, descuento, IVA). Las líneas sin producto quedan como gasto sin inventario.
- **Desde el XML del proveedor:** se leen proveedor, número, clave de acceso, fecha y líneas. Cada línea se relaciona con un producto por: 1) el código que ese proveedor ya usó antes (se recuerda al registrar), 2) el código del producto, 3) un código de barras. Las que no se reconocen se marcan para elegir el producto. Avisa si el XML no está emitido a nombre de la empresa o si esa factura ya se registró, y si las líneas no suman lo mismo que el XML.
- **Costo:** entra al kárdex el costo **neto sin IVA** (subtotal de la línea ÷ unidades base) y se recalcula el **costo promedio ponderado**. Prueba: 18 u a $6 + 12 u a $8 netos → $6,80.
- **Duplicados:** la misma factura (proveedor + tipo + número) no se registra dos veces.
- **Anular:** descuenta del stock lo que entró (`PURCHASE_RETURN`); si ya se vendió y la empresa no permite stock negativo, no deja anular.

## Pruebas

- Unitarias (`libs/sri-core/src/lib/xml/credit-note.spec.ts`): prorrateo y saldo del descuento, límite de cantidades, tres devoluciones parciales = factura, **XML válido contra el XSD oficial**, consumidor final rechazado, lectura del XML y RIDE en PDF.
- e2e (`apps/api/test/returns-purchases.e2e-spec.ts`, 8 casos): búsqueda por número y clave, devolución parcial con egreso de caja y reingreso al costo de la venta, autorización del SRI y RIDE, exceso rechazado, devolución total exacta, producto dañado sin reingreso, consumidor final exige identificación, cajero sin permiso, compra manual con costo promedio, XML del proveedor (relación por código y por código recordado, duplicado), anulación de compra.
- e2e caja de escritorio: **devolución sin conexión** → misma clave de acceso y número en el servidor, stock local actualizado al instante, no permite devolver dos veces lo mismo.
- Navegador: venta en la caja → F9 → devolución a consumidor final identificado → nota **autorizada** por el SRI simulado y enlazada a su factura; compra cargando un XML de proveedor de 3 líneas ($224,25), una línea relacionada a mano y otra como gasto.

## Pendiente

- **Comprobante de retención** (y su relación con las compras y el ATS) → siguiente fase, validando códigos y porcentajes con usted.
- Nota de crédito por descuento posterior (sin devolución de productos) y nota de débito.
- Cuentas por pagar a proveedores y saldo a favor del cliente → Fase 6 (cuentas por cobrar/pagar).
