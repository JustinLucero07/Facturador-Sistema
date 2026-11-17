# Fase 7 — Cuentas por cobrar y por pagar

## Qué hay

| Pieza | Dónde |
|---|---|
| Libro de cuentas (documentos, movimientos, aplicaciones) con saldo a favor | `libs/accounts`, tablas `account_item`, `account_movement`, `account_allocation` |
| Saldos por cliente/proveedor con antigüedad (al día, 1–30, 31–60, 61–90, más de 90) | **Cuentas → Por cobrar / Por pagar** |
| Estado de cuenta: documentos, movimientos, crédito disponible | clic en un cliente o proveedor |
| Cobros y pagos (repartidos del que vence primero, editable), anticipos, anulación | botón **Registrar cobro / pago** |
| Retenciones que le hacen sus clientes (desde el XML o a mano) | botón **Retención recibida** |
| Saldos iniciales (deudas anteriores al sistema) | botón **Saldo inicial** |
| API | `apps/api/src/app/accounts` |

## Reglas

- **Venta a crédito** (medio "Crédito" del POS o de la factura):
  - el cliente debe estar registrado y tener **límite de crédito**; no se puede pasar del límite (saldo pendiente + nueva venta);
  - vence según el plazo de la venta o, si no se indica, los **días de crédito del cliente**;
  - el plazo viaja en el XML (`<plazo>`, `<unidadTiempo>dias</unidadTiempo>`, como en el ejemplo de la Ficha).
  - Caja de escritorio sin conexión: la venta ya ocurrió, así que el servidor la registra aunque no haya límite o el cliente no exista (lo crea); la caja no conoce el saldo del cliente sin conexión.
- **Cobros y pagos**: se aplican a los documentos del más antiguo al más nuevo (se puede cambiar a mano); lo que sobra queda como **saldo a favor**. En **efectivo** con caja abierta, el cobro entra a la caja y el pago sale de ella (el arqueo cuadra solo).
- **Anular** un cobro/pago devuelve el saldo a los documentos y, si la caja sigue abierta, revierte el efectivo. Los movimientos que vienen de un comprobante electrónico (nota de crédito, retención emitida) no se anulan aquí.
- **Nota de crédito** con reembolso "Descontar de la deuda / saldo a favor": cancela primero la deuda de esa factura; el exceso queda como saldo a favor, que luego se aplica a otra factura desde el estado de cuenta.
- **Retención recibida**: se lee el XML del cliente, se valida que esté emitida a su RUC y se ubica la factura retenida; se verifica que base × porcentaje = valor retenido y que no se registre dos veces.
- **Compras**: al registrarlas se elige **a crédito** (vence con los días de crédito del proveedor o la fecha indicada) o **al contado** (se registra el pago). La **retención emitida** al proveedor descuenta lo que se le debe. Una compra con pagos aplicados no se puede anular sin anular antes los pagos.
- Permisos: por cobrar `receivables.manage`; por pagar `purchases.manage`. Todo cambio queda en la auditoría.

## Pruebas

- Unitarias: días de vencido y tramos de antigüedad.
- e2e (`apps/api/test/accounts.e2e-spec.ts`, 9 casos): crédito exige cliente con límite y crea la cuenta con su vencimiento y plazo en el XML; límite de crédito; abono en efectivo que entra a la caja; retención recibida leída del XML (validaciones y duplicado); nota de crédito que cancela la deuda y deja saldo a favor; uso del saldo a favor; saldo inicial vencido y antigüedad; anulación de cobro con reverso de caja; compra a crédito + retención emitida + pago; compra al contado en efectivo.
- Navegador: cliente demo con factura a crédito y dos saldos iniciales vencidos; cobro de $100 repartido automáticamente a las deudas más antiguas.

## Pendiente

- Las compras registradas **antes** de esta fase no tienen cuenta por pagar (solo afecta datos de prueba).
- Envío del estado de cuenta por correo/WhatsApp y recordatorios de vencimiento.
- Cheques posfechados y conciliación bancaria.
