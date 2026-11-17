# Instalación en la VPS de un cliente

Guía para el técnico de Vektra. Requisitos de la VPS: Ubuntu 24.04, 2 vCPU, 4 GB de RAM, 40 GB de disco, Docker y Docker Compose.

## 1. Registrar la instalación en el Vektra Hub

1. En el Hub → **Clientes**, cree el cliente (RUC, contacto).
2. En **Instalaciones**, cree la instalación con su plan.
3. Copie el bloque que aparece (`HUB_URL`, `INSTALLATION_ID`, `INSTALLATION_SECRET`). **El secreto se muestra una sola vez.**

## 2. Configurar la VPS

```bash
git clone <repositorio> vektra && cd vektra
cp .env.example .env
```

Complete en `.env`:

| Variable | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `POSTGRES_PASSWORD`, `VEKTRA_APP_PASSWORD` | contraseñas largas y distintas (`openssl rand -base64 24`) |
| `JWT_ACCESS_SECRET` | `openssl rand -base64 48` |
| `MASTER_KEY` | `openssl rand -base64 32` — **respáldela**: sin ella no se pueden leer las firmas electrónicas ni los secretos 2FA guardados |
| `WEB_ORIGIN` | URL pública, ej. `https://facturas.ferreteriax.com` |
| `HUB_URL`, `INSTALLATION_ID`, `INSTALLATION_SECRET` | del paso 1 |
| `LICENSE_PUBLIC_KEY` | llave pública oficial de Vektra |
| `SEED_SUPPORT_EMAIL`, `SEED_SUPPORT_PASSWORD` | usuario de Soporte Vektra de esta instalación |

## 3. Levantar

```bash
docker compose up -d --build
docker compose logs -f migrate worker   # con el Hub configurado: "Licencia permanente actualizada"
```

El servicio `migrate` aplica migraciones (incluidas las políticas RLS) y crea permisos y el usuario de soporte.

## 4. Crear la empresa del cliente

Ingrese con el usuario de soporte → **Soporte Vektra → Empresas** → **Nueva empresa**: RUC, razón social, tipo de negocio y el administrador del cliente. Se crean automáticamente el establecimiento 001, el punto de emisión 001, la bodega principal y los roles.

## 5. HTTPS

Coloque un proxy con TLS delante del puerto `WEB_PORT` (por ejemplo, Caddy con certificado automático). En la Fase 8 se incluirá en el compose.

## Notas

- **Activación (pago único):** en el Hub, Instalaciones → ⋮ → **Código de activación (permanente)**; el administrador lo pega una vez en **Empresa → Licencia**. No vence y no depende de la conexión con el Hub. Solo autoriza los RUC indicados en la instalación (⋮ → RUC autorizados); para una empresa nueva, genere un código nuevo.
- La base usa un rol sin privilegios (`vektra_app`) con Row Level Security: cada empresa solo ve sus datos.
