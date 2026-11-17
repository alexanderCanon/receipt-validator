# Receipt Validator · MVP Fase 1

Proyecto Cloudflare serverless: **un Worker + D1 + R2 + Static Assets**.

## Estado actual (importante)

✅ Carga de JPEG/PNG/WebP (máx. 5 MiB), validación de firmas de archivo, SHA-256, almacenamiento privado en R2, persistencia en D1, bloqueo de cargas con hash idéntico, frontend básico y verificación Turnstile en producción.

🚧 **Todavía NO implementado:** Workers AI, extracción de datos, detección de cheques, validación de antigüedad (>2 días), duplicados por referencia o semejanza visual, detección de manipulación, panel administrativo y revisión manual. El estado `PENDING_ANALYSIS` **no es aprobación**.

### Requisitos

- Node.js 20+ y npm.
- Cuenta Cloudflare con R2 habilitado. Algunas cuentas requieren habilitar facturación R2 aunque el uso quede dentro de la cuota gratuita.

### Instalación

```bash
npm install
npx wrangler login
npx wrangler d1 create receipt-validator-db
npx wrangler r2 bucket create receipt-validator-files
```

Copia el `database_id` obtenido al crear D1 en `wrangler.jsonc`, sustituyendo `REPLACE_WITH_REAL_D1_DATABASE_ID`.

### Desarrollo local

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Abre `http://localhost:8787`. En local, `DEV_BYPASS_TURNSTILE=true` permite pruebas sin Turnstile (nunca en producción). R2 y D1 se emulan localmente con Wrangler.

### Producción: proteger el formulario

1. Crea un widget **Cloudflare Turnstile** para el dominio de la aplicación.
2. Copia su **Site Key (pública)** en `public/config.js`, reemplazando la cadena vacía, (el HTML ya carga el archivo de configuración).
3. Añade la secret key con `npx wrangler secret put TURNSTILE_SECRET_KEY`.
4. Ejecuta:

```bash
npm run db:migrate:remote
npm run deploy
```

**No** configures `DEV_BYPASS_TURNSTILE` en el entorno remoto. El bypass además exige hostname local.

### Seguridad, privacidad y límites

- No hay endpoints públicos para leer las imágenes de R2.
- Los identificadores no confieren permiso para consultar registros; el endpoint de consulta aún responde 501.
- Los datos del comprobante pueden ser sensibles. Definir retención, autenticación y control de acceso antes de habilitar la revisión en producción.
- La primera versión rechaza una segunda subida **del mismo archivo binario**, incluso si su solicitud original no fue aprobada. Esto es una política temporal para el MVP y será sustituida por reglas según estado de validación.
- La verificación de firmas de imagen no garantiza que el archivo sea seguro o auténtico. No aceptamos formatos vectoriales.
- Se requiere evaluar el consumo de CPU del hashing de imágenes en el plan Free.

### Siguientes fases

1. Workers AI + extracción estructurada.
2. Clasificación (transferencia/efectivo/cheque), regla de 2 días, rechazo de cheque, comprobación de referencia y anomalías visuales.
3. Claims atómicos para bloquear duplicados semánticos, autenticación administrativa y flujo de revisión manual.

## Fase 2 — Workers AI y CI/CD

El endpoint `POST /api/receipts` procesa imágenes con `@cf/meta/llama-3.2-11b-vision-instruct`. Devuelve `APPROVED`, `REJECTED` o `REVIEW_REQUIRED`; la aprobación es **documental**, no confirma el depósito bancario. Clasifica cheques para rechazo, evalúa el límite de dos días calendario (Guatemala) y reserva referencias para evitar reutilización.

Las anomalías visuales producen `REVIEW_REQUIRED`, nunca una afirmación concluyente de falsificación. El detector requiere validación con comprobantes reales: la IA puede equivocarse y aún no hay revisión administrativa.

La migración `0002_ai_validation.sql` añade `receipt_claims`. En producción, el workflow de despliegue aplica migraciones **antes** de desplegar, solo después de CI exitoso en `main` o mediante ejecución manual.

Para GitHub Actions, configurar secretos `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`. El CI en PR instala dependencias, genera tipos con Wrangler, ejecuta TypeScript, tests y dry-run sin secretos. El deploy utiliza ambos secretos.

Para el primer uso del modelo Meta es necesario aceptar su licencia con una solicitud `prompt: "agree"` desde una cuenta autorizada. Consultar https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/.

Limitaciones: no hay análisis forense concluyente ni detección de duplicados de imágenes reeditadas sin referencia reconocible; el endpoint aún no implementa acceso administrativo a imágenes o revisión manual.
