# Vektra POS

Facturación electrónica SRI (Ecuador) + inventario + punto de venta. Producto de **Vektra Systems** (Cuenca).

Cada cliente tiene **su propia VPS** con una instancia del sistema. El **Vektra Hub** (servidor central de Vektra) emite las licencias, gestiona clientes y planes y recibe la telemetría. Ver [docs/00-propuesta-arquitectura.md](docs/00-propuesta-arquitectura.md).

## Estructura

| Ruta | Qué es |
|---|---|
| `apps/api` | API de la instancia (NestJS 12) |
| `apps/worker` | Tareas en segundo plano (BullMQ): validación de licencia; luego SRI y correo |
| `apps/web` | Frontend de la instancia (Angular 22 + Material) |
| `apps/desktop` | **Vektra Caja** (Electron): caja de escritorio que factura sin internet — ver [docs/fase-4-escritorio.md](docs/fase-4-escritorio.md) |
| `apps/hub-api`, `apps/hub-web` | Vektra Hub: licencias, clientes, planes |
| `libs/db` | Esquema Prisma de la instancia, migraciones (incluye **RLS**), seed, secuenciales |
| `libs/hub-db` | Esquema Prisma del Hub |
| `libs/sri-core` | SRI puro (servidor y escritorio): clave de acceso, cálculo, XML, XSD, firma XAdES-BES, SOAP, RIDE — ver [docs/fase-1-sri.md](docs/fase-1-sri.md) |
| `libs/einvoice` | Emisión y ciclo de vida de comprobantes (BD + colas), correo con XML + RIDE |
| `libs/inventory` | Kárdex con costo promedio ponderado, stock por bodega, ajustes y transferencias — ver [docs/fase-2-catalogo.md](docs/fase-2-catalogo.md) |
| Notas de crédito y compras | ver [docs/fase-5-notas-credito-compras.md](docs/fase-5-notas-credito-compras.md) |
| Retenciones | ver [docs/fase-6-retenciones.md](docs/fase-6-retenciones.md) (catálogo oficial en `docs/sri/Catalogo_ATS.xls`) |
| `libs/accounts` | Cuentas por cobrar y por pagar — ver [docs/fase-7-cuentas.md](docs/fase-7-cuentas.md) |
| `apps/api/src/app/reports`, `libs/sri-core/src/lib/ats` | Reportes (Excel) y ATS — ver [docs/fase-8-reportes-ats.md](docs/fase-8-reportes-ats.md) |
| `libs/pos-local` | Motor de la caja de escritorio: SQLite, API local y sincronización con el servidor |
| `libs/licensing` | Licencias firmadas Ed25519 (emisión y verificación) |
| `libs/shared-domain` | Reglas puras: validación de cédula/RUC, permisos, roles, plantillas de negocio |
| `libs/shared-contracts` | Esquemas zod y tipos compartidos API ↔ frontend |
| `libs/nest-common` | Pipe de validación y filtro de errores (mensajes en español) |

## Desarrollo local

Requisitos: Node 22, pnpm 9.15 (`corepack prepare pnpm@9.15.9 --activate`) y Docker.

```bash
pnpm install                      # también genera los clientes Prisma
cp .env.example .env              # completar secretos (ver comentarios); `pnpm keys:license` genera las llaves
pnpm dev:infra                    # Postgres :5440, Redis :6390, Mailpit :8025
pnpm db:deploy && pnpm db:seed    # instancia: migraciones + permisos + soporte + empresa demo
cd libs/hub-db && npx prisma migrate deploy && npx prisma db seed && cd -   # Hub

pnpm dev:hub      # http://localhost:3400/api
pnpm dev:api      # http://localhost:3300/api
pnpm dev:worker
pnpm dev:web      # http://localhost:4300
pnpm dev:hub-web  # http://localhost:4400
pnpm nx serve desktop   # caja de escritorio (requiere `pnpm nx build web`)
```

Usuarios de desarrollo (creados por el seed):

| Dónde | Usuario | Contraseña |
|---|---|---|
| Instancia — empresa demo | `admin@demo.local` | `Demo.2026!` |
| Instancia — Soporte Vektra | `SEED_SUPPORT_EMAIL` | `SEED_SUPPORT_PASSWORD` del `.env` |
| Hub | `HUB_SEED_ADMIN_EMAIL` | `HUB_SEED_ADMIN_PASSWORD` del `.env` |

**Licencia en desarrollo:** si `LICENSE_PUBLIC_KEY` está vacío (y `NODE_ENV` ≠ production) la instancia funciona sin licencia. Con la llave configurada, cree una instalación en el Hub, copie `INSTALLATION_ID`/`INSTALLATION_SECRET` al `.env` y arranque el worker.

## Pruebas

```bash
pnpm test        # unitarias (cédula/RUC, licencias…)
pnpm test:e2e    # API contra PostgreSQL real (base vektra_test) y un SRI simulado: aislamiento, secuenciales, auth, facturación completa
```

Las pruebas e2e no borran datos: cada ejecución crea empresas con RUC y correos aleatorios.

## Producción

- VPS del cliente: [docs/instalacion-vps.md](docs/instalacion-vps.md) (`docker-compose.yml`).
- Vektra Hub: `docker-compose.hub.yml` con su propio `.env.hub`.
