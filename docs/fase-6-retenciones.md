# Fase 6 — Comprobantes de retención

## Qué hay

| Pieza | Dónde |
|---|---|
| Comprobante de retención electrónico (07), **XML ATS v2.0.0** (Ficha v2.34, Anexo 10), firmado y enviado al SRI por la misma cola | `libs/sri-core/src/lib/xml/withholding.ts`, `libs/einvoice/src/lib/withholding.ts` |
| RIDE de la retención (formato de la versión 1.0.0, como indica la Ficha) y correo al proveedor | `libs/sri-core/src/lib/ride/ride.ts` |
| Catálogo de códigos en la BD, editable (no fijo en código) | tabla `withholding_code`; página **Facturación → Códigos de retención** |
| Emitir la retención desde la compra | Inventario → Compras → compra → **Emitir retención** |

## Fuentes oficiales (nada inventado)

| Dato | Fuente |
|---|---|
| Estructura XML y orden de campos | `ComprobanteRetencion_V2.0.0.xsd` del portal del SRI (zip "XML y XSD Comprobante de Retención") + Ficha v2.34, Anexo 10 |
| Impuesto a retener: 1 renta, 2 IVA, 6 ISD | Ficha v2.34, Tabla 19 |
| Códigos y porcentajes de **IVA**: 9=10 %, 10=20 %, 1=30 %, 11=50 %, 2=70 %, 3=100 %, 7=retención en cero, 8=no procede | Ficha v2.34, Tabla 20 |
| Conceptos y porcentajes de **renta** (127 códigos) | **Catálogo ATS** del SRI (`docs/sri/Catalogo_ATS.xls`), hoja "TABLAS RETENCIONES", Tabla 3.10, **vigente desde el 06/08/2026** |
| Sustento tributario (`codSustento`) | Catálogo ATS, Tabla 5 |
| Tipo de comprobante de sustento (`codDocSustento`) | Catálogo ATS, Tabla 4 |
| Formas de pago | Ficha v2.34, Tabla 24 (= Catálogo ATS, Tabla 13) |

La Ficha **no trae los porcentajes de renta**: remite al Catálogo ATS, que se descargó de la página de formularios del SRI. `tools/ats-catalog.mjs` vuelve a generar los datos cuando el SRI publique un catálogo nuevo. Los 50 conceptos cuyo porcentaje no es un número fijo ("12 o 14", "varios porcentajes", "1/0 según resolución") quedan **sin porcentaje**: al retener, el sistema pide ingresarlo y muestra el texto oficial.

## Reglas

- **Base de renta** ≤ subtotal de la compra; **base de IVA** ≤ IVA de la compra (por código y en total).
- El porcentaje es el del catálogo; no se puede cambiar en la retención (si cambia por resolución, se edita el catálogo con su fecha de vigencia).
- Códigos fuera de vigencia, inactivos o de **pagos al exterior** no se aceptan (los de no residentes quedan cargados pero inactivos: el XML de pagos al exterior, reembolsos y dividendos no está implementado todavía).
- Una compra solo puede tener **una retención vigente** (si el SRI la rechaza, se puede emitir otra).
- Sujeto retenido identificado (nunca consumidor final). `parteRel` se marca en la pantalla.
- Se emite desde un punto de emisión **web** (no desde la caja de escritorio). Permiso: `purchases.manage` ("Registrar compras y retenciones"); editar el catálogo: `tax.manage`.
- **Sugerencia:** al emitir a un proveedor, se cargan los códigos, el sustento y la forma de pago de su última retención. No se proponen porcentajes por tipo de contribuyente: eso lo decide el usuario/contador.

## Para validar con su contador

Códigos que suele usar una ferretería (del catálogo cargado; revise que apliquen a su caso):

| Código | Concepto (Catálogo ATS) | % |
|---|---|---|
| 312 | Transferencia de bienes muebles de naturaleza corporal | 2 |
| 303 | Honorarios profesionales (título profesional) | 10 |
| 304 | Servicios donde predomina el intelecto (sin título) | 10 |
| 307 | Servicios donde predomina la mano de obra | 3 |
| 309 | Servicios de medios de comunicación y agencias de publicidad | 3 |
| 310 | Transporte privado de pasajeros / carga | 1 / 0 según resolución (variable) |
| 320 | Arrendamiento de bienes inmuebles | 10 |
| 322 | Seguros y reaseguros | 2 |
| 332 | Compras no sujetas a retención (incluye RIMPE Negocio Popular) | 0 |
| 343 | Otras retenciones aplicables el 1 % (incluye RIMPE Emprendedor) | 1 |
| 3440 | Otras retenciones aplicables el 3 % | 3 |

IVA: 1 (30 %), 10 (20 %), 2 (70 %), 3 (100 %), 9 (10 %), 11 (50 %), 7 y 8. **Qué porcentaje de IVA corresponde depende de quién retiene y a quién** (contribuyente especial, agente de retención, RIMPE, etc.): el sistema no lo decide.

Pendientes de confirmar:
- **Plazo** para emitir la retención desde la recepción de la factura del proveedor (está en el Reglamento de Comprobantes de Venta, no en la Ficha): el sistema no lo controla todavía.
- Si su empresa es **agente de retención**, configure el número de resolución en Empresa (sale en `agenteRetencion` del XML y del RIDE, Anexo 21).

## Pruebas

- Unitarias (`libs/sri-core/src/lib/xml/withholding.spec.ts`): valor retenido, **XML válido contra el XSD oficial v2.0.0** (incluye 1,75 % y 100 %), consumidor final y número de sustento inválidos rechazados, lectura del XML y RIDE en PDF.
- e2e (`apps/api/test/withholdings.e2e-spec.ts`, 6 casos): catálogo oficial cargado (312 = 2 %, 303 = 10 %, 312C = 1,75 %, 327 variable, IVA 30/70/100), borrador con bases de la compra, validaciones (base > subtotal, base > IVA, porcentaje distinto, porcentaje variable sin ingresar), emisión con XML válido y valores correctos (renta 307 3 % + IVA 70 % = $135), autorización del SRI y RIDE, una sola retención vigente por compra y sugerencia de la última, edición del catálogo.
- Navegador: retención sobre la compra de Distribuidora Austral (renta 312 2 % sobre $207 + IVA 30 % sobre $17,25 = **$9,32**), **autorizada** por el SRI simulado y enlazada a la compra; página del catálogo.

## Pendiente

- Retenciones por pagos al exterior, reembolsos de gastos y dividendos (los campos existen en el XSD).
- Registrar las **retenciones que le hacen sus clientes** (al cobrar facturas) → con cuentas por cobrar.
- ATS (reporte mensual) a partir de compras, ventas y retenciones.
