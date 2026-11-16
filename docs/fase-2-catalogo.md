# Fase 2 — Productos, clientes, inventario e importación Excel

## Qué hay

| Pieza | Dónde |
|---|---|
| Productos: código, varios códigos de barras, categoría, marca, unidad base, IVA, código auxiliar SRI, stock mínimo, imagen, servicio | `apps/api/src/app/catalog/products.service.ts` |
| Presentaciones y conversiones (CAJA = 12 UND, venta por metro/kilo con decimales) | tabla `product_unit` |
| Precios **sin IVA** por lista (Público, Mayorista, Distribuidor) y por presentación; se pueden ingresar con IVA (PVP) | tabla `product_price` |
| Buscador para factura/POS: código de barras exacto (devuelve la presentación escaneada), código o nombre | `GET /api/products/search` |
| Clientes y proveedores (una tabla `party`) con cédula/RUC validados, lista de precios, crédito | `apps/api/src/app/catalog/parties.controller.ts` |
| Kárdex con **costo promedio ponderado**, stock por bodega, ajustes con motivo, transferencias | `libs/inventory` |
| La factura descuenta stock (en unidades base) de la bodega principal del establecimiento | `libs/einvoice/src/lib/issue.ts` |
| Importación Excel con plantilla, vista previa y errores fila por fila | `apps/api/src/app/catalog/imports.service.ts` |

## Reglas

- **Costo promedio:** `(existencia × promedio + cantidad × costo) / (existencia + cantidad)` en cada entrada con costo (saldo inicial, compra, ajuste de entrada). Las salidas se valoran al promedio vigente y no lo cambian. Si la existencia previa era negativa (se vendió sin stock), el promedio pasa a ser el costo de la entrada.
- **Concurrencia:** cada movimiento bloquea la fila del producto (`SELECT … FOR UPDATE`), así dos cajas no calculan el promedio a la vez.
- **Stock negativo:** configurable por empresa (Empresa → Inventario). Si no se permite, la factura no se emite y el secuencial **no** se consume. Las transferencias nunca dejan negativa la bodega de origen.
- **El kárdex es de solo inserción** para la app: los errores se corrigen con ajustes, nunca editando movimientos.
- Unidades y listas de precios iniciales se crean con cada empresa (`libs/db/src/lib/catalog-defaults.ts`).

## Importación Excel

1. **Plantilla** generada según la empresa (una columna por lista de precios, listas desplegables de unidades, IVA y SI/NO, hoja de instrucciones).
2. **Vista previa:** valida cada fila (obligatorios, números, unidades, tarifas, cédula/RUC, duplicados dentro del archivo, códigos de barras de otros productos) y muestra `fila · columna · problema`. Nada se guarda.
3. **Confirmar:** importa solo las filas válidas, por lotes de 250. Si el código ya existe, se **actualiza**. Las categorías y marcas que no existen se crean.

Criterio de aceptación cumplido: **2.000 productos** (con 4 filas erróneas) → vista previa + confirmación en ~1,4 s (prueba `apps/api/test/catalog.e2e-spec.ts`).

## Pendiente para fases siguientes

- Campos personalizados configurables (la columna `custom_fields` ya existe) → Fase 6.
- Variantes, lotes y series → Fase 6.
- Toma física guiada (conteo) → se puede registrar hoy como ajuste con motivo "conteo físico".
- Compras a proveedores que actualizan costo y stock → Fase 5.
