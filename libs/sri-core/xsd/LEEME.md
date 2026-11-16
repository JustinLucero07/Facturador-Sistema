# Esquemas XSD del SRI

- `oficial/`: archivos **sin modificar**, descargados del portal del SRI (https://www.sri.gob.ec/facturacion-electronica) el 2026-11-16:
  - `factura_V1.1.0.xsd`, `factura_V2.1.0.xsd`, `ejemplo-factura_V1.1.0.xml` (zip "XML y XSD Factura").
  - `xmldsig-core-schema.xsd` (W3C, importado por los XSD del SRI).
- Raíz de `xsd/`: copias que usa el sistema para validar antes de firmar.

## Diferencias con los oficiales

| Archivo | Cambio | Motivo |
|---|---|---|
| `factura_V1.1.0.xsd`, `factura_V2.1.0.xsd` | `contribuyenteRimpe` acepta también `CONTRIBUYENTE NEGOCIO POPULAR - RÉGIMEN RIMPE` | La Ficha Técnica offline v2.34, Anexo 22 (pág. 130), exige ese texto (45 caracteres) para contribuyentes Negocio Popular en la misma etiqueta, pero el XSD publicado solo admite `CONTRIBUYENTE RÉGIMEN RIMPE`. Pendiente confirmar contra el ambiente de pruebas del SRI con un emisor Negocio Popular. |

Cuando el SRI publique nuevos XSD, reemplace `oficial/`, vuelva a aplicar (o retire) los cambios de la tabla y ejecute `pnpm nx run sri-core:xsd-bundle`.
