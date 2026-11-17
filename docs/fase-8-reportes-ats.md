# Fase 8 — Reportes y ATS

> El cobro de Vektra desde el Hub, que era la "Fase 8" en la propuesta, pasa a ser la **Fase 9**.

## Qué hay

| Pieza | Dónde |
|---|---|
| ATS mensual o semestral (RIMPE): revisión previa, XML para el DIMM y `ATmmaaaa.zip` | **Reportes → ATS** (`reports.tax`) |
| Generador del XML y empaquetado ZIP | `libs/sri-core/src/lib/ats` |
| Esquema oficial | `libs/sri-core/xsd/oficial/ATS_at.xsd` (del DIMM ATS 1.19.0, 09/2026); la copia de validación quita solo el BOM |
| Ficha técnica ATS (SRI, actualizada 07/02/2025) | `docs/sri/Ficha-Tecnica-ATS.pdf` |
| 12 reportes con descarga a Excel | **Reportes → Reportes** (`reports.read`; IVA requiere `reports.tax`) |
| API | `GET /api/reports?kind=…&from=…&to=…&format=json|xlsx`, `GET /api/reports/ats?year&month&semiannual&format=json|xml|zip` |
| Datos ATS en compras: sustento, forma de pago, parte relacionada | formulario de compra y detalle (**Cambiar**); `POST /api/purchases/:id/ats` |
| Datos ATS en clientes/proveedores: parte relacionada, tipo de persona (pasaporte/exterior, Tabla 14) | ficha del cliente/proveedor |

## Reportes

Ventas por día, por producto, por categoría, por cajero y por forma de pago; utilidad por producto (costo promedio del kárdex al vender); cierres de caja; inventario valorizado; compras por proveedor; cartera por cobrar y cuentas por pagar (con antigüedad); resumen de IVA y retenciones (ayuda para el formulario 104).

Ventas = facturas − notas de crédito, excluyendo las rechazadas por el SRI.

## Cómo se arma el ATS

- **Compras**: las registradas en el período. La fecha de registro contable es el día en que se ingresó la compra al sistema.
  - Bases por tarifa: el código 6 va como no objeto y el 7 como exento.
  - Retenciones de IVA: se ubican en el campo de su porcentaje (10/20/30/50/70/100).
  - Retención de renta: va con su concepto. Si no hay retención de renta, se informa el concepto del parámetro `ats.noWithholdingConcept` (332) al 0 %, como pide la Ficha.
  - Retención emitida: va con su número y autorización; solo se incluye la que está autorizada.
  - `pagoExterior`: va con `pagoLocExt 01` y "NA" en los demás campos (solo pagos a residentes).
  - Forma de pago: solo cuando bases + impuestos superan `ats.paymentFormThreshold` (USD 500 desde 20/12/2023).
- **Ventas**: los comprobantes **autorizados**, agrupados por cliente.
  - Facturas = código 18 de la Tabla 4; notas de crédito = código 04.
  - Tipo de emisión `E`; consumidor final con 9999999999999.
  - Se suman las retenciones que le hicieron en el período (Fase 7).
- **Total de ventas y ventas por establecimiento**: facturas − notas de crédito, con un registro por cada establecimiento activo.
- **Anulados**: vacío. Los comprobantes electrónicos se anulan en el portal del SRI y la Ficha (2.5) los excluye.
- **Revisión previa**:
  - Errores que impiden la descarga: falta de sustento, falta de forma de pago cuando corresponde, falta de autorización, falta del tipo de persona con pasaporte.
  - Avisos: comprobantes aún no autorizados, ventas exentas, retenciones de clientes sin ventas en el período.
  - El XML se valida contra el XSD antes de entregarse.

## Para confirmar con el contador

1. **Ventas electrónicas en el ATS.**
   - La Ficha (numeral 1, Res. NAC-DGERCGC16-00000092) dice que quien emite electrónicamente no las registra en los módulos de compras y ventas. Pero el campo `tipoEmision` (Tabla 20) admite `E`, y el numeral 2.3 pide informar ahí las retenciones recibidas.
   - Hoy se detallan todas (`ats.includeElectronicSales = true`) y suman al total de ventas (`ats.electronicSalesInTotals = true`).
   - Con `includeElectronicSales = false` solo se informan los clientes con retenciones.
2. **Compras con retención electrónica v2.0.0.** La Ficha de comprobantes electrónicos (Anexo 10) dice que ese comprobante "incluye la información del módulo de compras". Hoy esas compras igual se informan en el ATS.
3. **Ventas exentas de IVA.** El módulo de ventas no tiene campo para exentos, así que se suman a la tarifa 0 % (con aviso).
4. **Fecha de registro contable.** Hoy es el día en que se ingresó la compra; una compra de fin de mes ingresada al mes siguiente va a ese mes.

## Pruebas

- Unitarias (`ats.spec.ts`, 7): XML válido contra el XSD con compras, ventas, pasaporte, consumidor final, semestral y anulados; limpieza de razón social; nombre y ZIP.
- e2e (`apps/api/test/reports.e2e-spec.ts`, 6): revisión previa con errores y bloqueo de descarga; corrección de la compra; XML válido con retenciones emitidas y recibidas, concepto 332 y nota de crédito; ZIP; todos los reportes con sus cifras; Excel; validación de filtros.
- Navegador: ATS de noviembre del demo listo; reportes en escritorio y celular.

## Pendiente

- Pagos al exterior, reembolsos, dividendos y exportaciones en el ATS.
- Liquidaciones de compra y notas de crédito de proveedores.
- Validar un archivo real en el DIMM del SRI con los datos de su empresa.

## Cambio de modelo: pago único y licencia permanente (17/11/2026)

El sistema se vende con **un solo pago** (el cliente paga su VPS; soporte y actualizaciones se cobran aparte). Por eso se descartó la fase de cobro mensual y la licencia pasó a ser **permanente**:

- **Código de activación:** lo firma el Hub y se ingresa una vez (Empresa → Licencia). No vence y no necesita conexión con el Hub.
- **Atado a la instalación y a los RUC autorizados.** Una empresa con un RUC no autorizado queda en solo lectura y no se puede dar de alta (`LicenseService.status(tenantId)` / `assertRucAllowed`).
- **El Hub ya no puede bloquear.** Si está configurado, la instancia le reporta su estado y recibe el código actualizado. Nunca recibe nada que la suspenda.
- **Compatibilidad:** se siguen aceptando las licencias antiguas con vencimiento.
- **Pruebas:**
  - `libs/licensing` (12): firma, vencimiento, licencia permanente y RUC.
  - e2e `apps/api/test/license.e2e-spec.ts` (4): sin licencia, códigos inválidos, RUC no autorizado y ampliación de RUC.
