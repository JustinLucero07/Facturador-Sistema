# Vektra POS — guía para agentes

- Producto comercial: facturación SRI Ecuador + inventario + POS. Se construye **por fases** (ver `docs/00-propuesta-arquitectura.md`); no avanzar de fase sin aprobación del usuario.
- Código en inglés; **toda la interfaz y los mensajes de error en español (Ecuador)**. USD, America/Guayaquil.
- **No inventar especificaciones del SRI**: usar la Ficha Técnica offline y XSD oficiales; preguntar si hay duda. Valores tributarios siempre en BD, nunca fijos en código.

## Comandos

- pnpm 9.15.9 (no hay npm en esta máquina; pnpm está en `~/.local/bin`). Ejecutar tareas con `pnpm nx <target> <proyecto>`.
- Infra dev: `pnpm dev:infra` (Postgres 5440, Redis 6390, Mailpit 8025).
- Pruebas: `pnpm nx test <lib>` (Jest), `pnpm nx e2e api` (Vitest contra Postgres real, no destructivo).
- Prisma: ejecutar desde `libs/db` o `libs/hub-db` (`../../node_modules/.bin/prisma ...`). Nunca `migrate reset` sin consentimiento explícito del usuario.

## Reglas de arquitectura

- Toda tabla de negocio lleva `tenant_id` + política RLS (agregar la tabla a la migración de RLS). La app usa el rol `vektra_app`; acceder a datos de empresa SIEMPRE con `PrismaService.tx()` / `withContext()`.
- IDs con `uuidv7()` de `@vektra/db` (generables offline).
- Secuenciales solo con `nextSequential()` dentro de la transacción del comprobante.
- Validación de entrada con esquemas zod de `@vektra/shared-contracts` + `ZodPipe`; permisos con `@RequirePermissions()`.
- Cambios auditables: `AuditService.record(tx, …)` dentro de la misma transacción.
- Migraciones: NUNCA `GRANT ... ON ALL TABLES` (reabre UPDATE/DELETE en `audit_log`); los permisos de tablas nuevas llegan por default privileges.
- NestJS 12 es ESM: pruebas de apps Nest con Vitest + SWC (`tools/vitest-nest.mts`), no Jest.
- UI: Angular Material (PrimeNG 22 requiere licencia de pago; no usarlo).
- Caja de escritorio (`apps/desktop` + `libs/pos-local`): sin módulos nativos (SQLite = `node:sqlite`, argon2 = `hash-wasm`); no importar `@vektra/db` ni `@vektra/sri-core` completos ahí (usar `@vektra/db/uuid`, `@vektra/sri-core/calc`, `@vektra/sri-core/access-key`). Toda operación nueva de la caja va por la cola (`ctx.enqueue`) y su manejo en el servidor debe ser idempotente (`sync.service.ts`).
- En Electron lanzado desde VS Code hay que quitar `ELECTRON_RUN_AS_NODE` (ya lo hace `nx serve desktop`).
