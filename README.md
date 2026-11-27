# EduAndes AI — Edición 100% Nativa para Netlify

Versión completa y 100% funcional de **EduAndes AI (Chile – Ecuador · ODS 4)** diseñada específicamente para ejecutarse de punta a punta en **Netlify** sin servidores externos, manteniendo exactamente el mismo diseño visual, base precargada (3 asignaturas, 10 PDFs, 731 páginas indexadas), seguridad y flujos pedagógicos que la aplicación original.

---

## Arquitectura en Netlify

```text
Navegador (SPA React + tour-guiado.js + admin-panel.js + tutor-chat.js)
   │
   ├── Activos estáticos + 10 PDFs precargados ──▶ Netlify CDN (`public/` + `/seed-materials/*.pdf`)
   │
   └── Todas las rutas `/api/*` ─────────────────▶ Netlify Function v2 (`netlify/functions/api.mjs`)
                                                       ├── Autenticación Argon2id (OWASP) + Cookie HttpOnly
                                                       ├── CSRF + RBAC fail-closed + Cabeceras OWASP
                                                       ├── Núcleo de verificación documental (`native-core.mjs`)
                                                       ├── Importador PDF (`unpdf`) y PPTX (`jszip`) anti-XXE/VBA
                                                       ├── Persistencia fuerte: Netlify Blobs (`eduandes-db` / `eduandes-files`)
                                                       └── Motor IA Cloud: Groq / OpenAI-compat / Amazon Bedrock (SigV4)
```

### Garantía de compatibilidad 100% con el plan gratuito de Netlify
- **Sin límites de timeout (10 s):** La generación de cuestionarios (5 a 30 preguntas), refuerzos personalizados y prácticas ampliadas (10 a 20 preguntas) avanza en lotes paralelos de ~6 s sincronizados con el polling nativo del frontend, sin requerir Background Functions de pago.
- **Sin límite de 6 MB en PDFs precargados:** Los 10 PDFs universitarios (hasta 9,2 MB) se sirven directamente desde la CDN de Netlify mediante redirección autenticada `302` que preserva el salto a página exacta (`#page=N`).
- **Sin bases de datos externas obligatorias:** Usa **Netlify Blobs** con `consistency: "strong"` y auto-inicialización automática en el primer arranque con las 3 asignaturas, 3 unidades, 10 materiales, 731 páginas y 4 cuentas Argon2id.

---

## Despliegue en Netlify (Paso a Paso)

### Opción A — Conectar repositorio desde GitHub (Recomendado)
1. Sube esta carpeta (`EDUANDES_IA_NETLIFY`) a un repositorio en GitHub.
2. En [app.netlify.com](https://app.netlify.com), haz clic en **Add new site → Import an existing project** y elige el repositorio.
3. Netlify detectará automáticamente `netlify.toml`:
   - **Build command:** `npm run build`
   - **Publish directory:** `public`
   - **Functions directory:** `netlify/functions`
4. Ve a **Site configuration → Environment variables** y agrega las variables del motor IA:
   - `EDUCORE_ENGINE` = `openai_compat`
   - `EDUCORE_LLM_BASE_URL` = `https://api.groq.com/openai/v1`
   - `EDUCORE_LLM_API_KEY` = `tu_api_key_de_groq`
   - `EDUCORE_LLM_MODEL` = `llama-3.3-70b-versatile` *(o `llama-3.1-8b-instant` / `qwen/qwen3-32b`)*
5. Haz clic en **Trigger deploy → Deploy site**. ¡Listo!

### Opción B — Despliegue directo con Netlify CLI
```bash
npm install
npx netlify login
npx netlify init
npx netlify env:set EDUCORE_ENGINE openai_compat
npx netlify env:set EDUCORE_LLM_BASE_URL https://api.groq.com/openai/v1
npx netlify env:set EDUCORE_LLM_API_KEY gsk_tu_clave_aqui
npx netlify env:set EDUCORE_LLM_MODEL llama-3.3-70b-versatile
npx netlify deploy --prod
```

---

## Cuentas iniciales (precargadas con Argon2id)

| Rol | Correo | Contraseña inicial |
|---|---|---|
| **Administrador** | `administrador@ecuachile.cl` | `123456` |
| **Docente** | `docente@ecuachile.cl` | `123456` |
| **Estudiante** | `estudiante@ecuachile.cl` | `123456` |
| **Directivo / Orientador** | `orientacion@ecuachile.cl` | `123456` |

> Puedes sobrescribir las contraseñas iniciales antes del primer despliegue usando `EDUCORE_SEED_ADMIN_PASSWORD`, `EDUCORE_SEED_TEACHER_PASSWORD`, `EDUCORE_SEED_STUDENT_PASSWORD` y `EDUCORE_SEED_WELLNESS_PASSWORD`, o cambiarlas luego desde el **Panel Admin**.

---

## Desarrollo y pruebas locales (requiere Node.js 20+)

```bash
npm install
cp .env.example .env   # Agrega tu EDUCORE_LLM_API_KEY
npm test               # Ejecuta la suite E2E completa (sin consumir cuota LLM)
npm run dev:local      # Levanta la app en http://127.0.0.1:8888/#/
# o con Netlify CLI:
npm run dev
```

---

## Funcionalidades incluidas (100% paridad con `EDUANDES_IA`)
- Login moderno Chile–Ecuador con banderas animadas, mostrar/ocultar contraseña, Argon2id y cookies `HttpOnly`.
- 3 asignaturas precargadas (`EDU2026MAT`, `EDU2026INF`, `EDU2026IA`) con 10 PDFs y 731 páginas indexadas.
- Subida de nuevos materiales PDF, PowerPoint `.pptx` (con filtros anti-XXE, anti-traversal y anti-macros VBA) y texto libre.
- Generación de prácticas y evaluaciones (5 a 30 preguntas: selección múltiple, abiertas o mixtas) con verificación determinista de **cita literal exacta**.
- Revisión docente, edición con bloqueo optimista de versión y publicación inmutable.
- Espacio Estudiante con aislamiento por perfil, intentos idempotentes (UUIDv5), analítica de progreso por tema, refuerzos personalizados con verificación ciega, repaso de preguntas falladas y práctica ampliada (10–20 preguntas).
- Tutor flotante **AndesBot** con RAG sobre los PDFs indexados y bloqueo automático en Modo Evaluación.
- **Panel de Administración** completo de 8 secciones: usuarios Argon2id, CSV import/export, RBAC, gestión académica/RAG, gobernanza IA, analíticas, auditoría inmutable, respaldos, modo mantenimiento real y acceso excepcional a chats.
- Opciones de **Inclusión y Accesibilidad (ODS 4)**: lectura en voz alta (TTS), alto contraste, texto ampliado A+ y subtítulos visuales.
