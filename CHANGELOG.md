# Registro de cambios (CHANGELOG)

Todos los cambios relevantes de **LapiStock** se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa
[Versionado Semántico](https://semver.org/lang/es/): `MAYOR.MENOR.PARCHE`.

- **MAYOR**: cambios incompatibles (p. ej. una nueva estructura de IndexedDB que requiera migración).
- **MENOR**: funcionalidades nuevas compatibles con la versión anterior.
- **PARCHE**: correcciones de errores compatibles.

## [Sin publicar]

_Nada por ahora._

## [1.1.0] - 2026-11-14

Versión candidata validada: `v1.1.0-rc.1`.

### Agregado
- **Exportar CSV** en la vista Inventario: descarga la lista (respetando búsqueda y filtros) en
  formato CSV con BOM UTF-8 para que Excel muestre los acentos. Se genera en el navegador, así que
  funciona sin conexión.
- Contador **«Mostrando N de M lápices»** en Inventario.
- Prueba automatizada de actualización y reversión (`npm run test:actualizacion`).

### Cambiado
- Mensaje de bienvenida de Inicio: anuncia la versión 1.1 y la nueva exportación.
- Versión de la aplicación: `1.0.0` → `1.1.0` (visible al pie de Inicio).

### Corregido
- **Service Worker**: una respuesta de error (404/500) durante una navegación ya no reemplaza el
  `index.html` guardado en caché; antes la app podía dejar de abrir sin conexión.
- **Service Worker**: el precache de una versión nueva se descarga con `cache: 'reload'`, evitando
  que guarde el HTML de la versión anterior desde la caché HTTP del navegador.

### Datos del usuario
- Sin cambios en el esquema de IndexedDB (`lapistock`: `lapices`, `movimientos`, `outbox`, fotos)
  ni en las claves de localStorage. La actualización **no requiere migración** y conserva los datos.

## [1.0.0] - 2026-11-07

Versión inicial publicada.

### Agregado
- PWA de inventario de lápices (React 19 + Vite) con API Express + SQLite.
- Alta, edición y baja de lápices; movimientos de entrada y salida con validación de stock.
- Modo sin conexión: Service Worker con precache, IndexedDB y cola de sincronización sin duplicados.
- Splash Screen, Home Screen, KPIs, resumen del servidor y bitácora de sincronización.
- Cámara para foto del lápiz, notificaciones locales de bajo stock y Web Push (VAPID).
- Aviso «Nueva versión → Actualizar» del Service Worker.
- Pruebas de API, E2E (offline, permisos, actualización) y funcionales en Chrome y Edge.
- Configuración de publicación en Netlify.

[Sin publicar]: https://github.com/Michel2096/class24-10-26/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/Michel2096/class24-10-26/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Michel2096/class24-10-26/releases/tag/v1.0.0
