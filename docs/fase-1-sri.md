# Fase 1 — Núcleo SRI

Fuente oficial: **Ficha Técnica de Comprobantes Electrónicos — Esquema Offline v2.34 (27/07/2026)** y XSD del portal del SRI, guardados en [docs/sri/](sri/) y [libs/sri-core/xsd/oficial/](../libs/sri-core/xsd/oficial/).

## Qué hay

| Pieza | Dónde | Referencia en la ficha |
|---|---|---|
| Clave de acceso 49 dígitos, módulo 11 (11→0, 10→1) | `libs/sri-core/src/lib/access-key.ts` | 5.2, Tablas 1–4 |
| Cálculo de totales; IVA sobre la base agrupada por tarifa; propina ≤ 10 % | `libs/sri-core/src/lib/calc.ts` | Tabla 21, 9.17 |
| XML de factura 1.1.0 (2.1.0 también validada), en forma canónica | `libs/sri-core/src/lib/xml/invoice.ts` | Anexo 3, XSD |
| Validación XSD antes de firmar (libxml2 en WebAssembly) | `libs/sri-core/src/lib/xsd/validate.ts` | 5.1 |
| Firma XAdES-BES enveloped, RSA-SHA1, C14N | `libs/sri-core/src/lib/sign/` | 6, Anexo 14 |
| Cliente SOAP recepción/autorización | `libs/sri-core/src/lib/soap/client.ts` | 7, WSDL |
| Mensajes de error legibles | `libs/sri-core/src/lib/soap/messages.ts` | 11 |
| RIDE PDF (desde el XML firmado/autorizado) | `libs/sri-core/src/lib/ride/ride.ts` | Anexo 2 |
| Emisión, estados, reintentos, correo | `libs/einvoice` + `apps/worker/src/app/sri.processor.ts` | 5.10–5.12, 7.4 |
| Tarifas, catálogos y parámetros (editables) | tablas `tax_rate`, `sri_catalog`, `sri_setting` | Tablas 6, 17, 24; 9.10; Anexos 22, 26 |

## Estados del comprobante

`SIGNED` (firmado) → `RECEIVED` (recibido) → `AUTHORIZED`
`RETURNED` (devuelto en recepción) y `NOT_AUTHORIZED`: se corrigen y se reenvían con **la misma clave y secuencial** (5.10).
`CONTINGENCY`: el SRI no respondió; se reintenta con espera exponencial y un barrido cada 5 min. Códigos 43/70 → se consulta la autorización sin reenviar (nota 2 del numeral 11).

## Decisiones y desviaciones

1. **RIMPE Negocio Popular**: el XSD publicado solo acepta `CONTRIBUYENTE RÉGIMEN RIMPE`, pero el Anexo 22 exige `CONTRIBUYENTE NEGOCIO POPULAR - RÉGIMEN RIMPE` en la misma etiqueta. Se parchó la copia local del XSD (ver `libs/sri-core/xsd/LEEME.md`). **Pendiente** confirmarlo en pruebas con un emisor Negocio Popular.
2. **Anexo 26 (RUC del proveedor del sistema)**: cuando `sri_setting.provider_ruc` tenga el RUC de Vektra Systems, cada comprobante incluye `<campoAdicional nombre="RUC Proveedor">`. Aplica si Vektra consta en la Resolución NAC-DGERCGC26-00000027; **configurar antes de producción**.
3. **Tipo de emisión**: siempre `1` (en el esquema offline solo existe la emisión normal, Tabla 2). "En contingencia" significa "firmado, pendiente de envío".
4. **Consumidor final**: máximo $50 (numeral 9.10), en `sri_setting.final_consumer.maxAmount`.
5. **RIDE con PDFKit** (JavaScript puro) en lugar de HTML→PDF con Chromium: el mismo código corre en el servidor y en la caja sin internet, y la imagen Docker no crece unos 300 MB.
6. **Formas de pago**: el medio interno (efectivo, Deuna, Payphone…) se mapea a un código de la Tabla 24. Deuna y Payphone usan `20`/`19` como valor inicial; **confirme con su contador** el código que corresponde a cada medio.

## Pruebas automáticas

- `pnpm nx test sri-core` — 58 pruebas: claves de ejemplo de la ficha, el ejemplo numérico del RIDE oficial (total 369,50), validación XSD, forma canónica idéntica a libxml2, firma verificada por **xml-crypto** (implementación independiente) y detección de alteraciones.
- `pnpm nx e2e api` — flujo completo contra un **SRI simulado** que verifica la firma: emitir → recibir → autorizar → XML autorizado → RIDE → correo, más contingencia, no autorizado, consumidor final, cambio de tarifa y aislamiento entre empresas.
- Cliente SOAP comprobado contra el **ambiente de pruebas real** (`celcer.sri.gob.ec`): un XML inválido vuelve `DEVUELTA` con el error 35, como indica la ficha.

## Prueba final con su firma real (criterio de aceptación)

Requisitos: RUC con autorización de emisión electrónica en **ambiente de pruebas** (SRI en línea), certificado `.p12` vigente y su contraseña.

1. `pnpm dev:infra`, luego API, worker y web (ver README).
2. Ingrese como **Soporte Vektra** → Soporte Vektra → Empresas → cree la empresa con **su RUC real**, la razón social exacta del RUC y la dirección matriz. En Empresa, deje el ambiente en **Pruebas**.
3. En Establecimientos, verifique que el código del establecimiento coincida con el del RUC.
4. Facturación → Firma y correo → cargue el `.p12` y configure el SMTP.
5. Nueva factura → cliente con datos (puede usar la razón social `PRUEBAS SERVICIO DE RENTAS INTERNAS`, numeral 5.6) y su correo.
6. El comprobante debe pasar a **Autorizado**, con la advertencia 60 "ambiente de pruebas", y llegar el correo con el XML y el RIDE.

Si el SRI lo devuelve, el detalle del comprobante muestra el código y la explicación; se corrige y se usa **Reenviar al SRI** con la misma clave.
