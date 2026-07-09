# ROADMAP — yt-music-mcp

Estado de funcionalidades: ✅ implementado | ⏳ pendiente

---

## Análisis y Stats

### Radar semanal / mensual ✅
Resumen tipo "Spotify Wrapped" liviano:
- Tool MCP: `ytm_wrapped` con `period: "week" | "month"`
- Dashboard web con carrusel de stats, top 10 artistas/canciones/géneros, heatmap, distribución horaria, obsesiones y revival

### Heatmap de escucha ✅
- Últimos 7 o 30 días en visualización GitHub-style
- Distribución horaria y semanal
- Comando CLI: `yt-history heatmap [days]`

### Detección de obsesiones ✅
- Tool MCP: `ytm_obsessions`
- Comando CLI: `yt-history obsessions [threshold] [days]`

---

## Playlists Inteligentes

### Playlists por vibes detectadas ✅
- Tool MCP: `ytm_vibe_play` — detecta hora/día y elige género, arma mix automático
- Usa historial real para seleccionar canciones

### Descubrimiento semanal ✅
- Tool MCP: `ytm_discover_weekly`
- Busca canciones nuevas en YT Music de tus top 3 géneros

### Revival mix ✅
- Tool MCP: `ytm_revival`
- Comando CLI: `yt-history revival [days]`

---

## Control Reactivo

### Modo fiesta ✅
- Tool MCP: `ytm_fiesta_mode`
- Si hay ≥3 canciones recientes con BPM ≥ threshold, sube volumen e intenta crossfade

### Sincronización con clima ✅
- Tool MCP: `ytm_weather_play` con vibes: morning / afternoon / night / rainy / sunny / chill
- Usa géneros del historial según el vibe elegido

### Letras en vivo ✅
- Tool MCP: `ytm_lyrics`
- Consulta el endpoint `/api/v1/lyrics` del plugin synced-lyrics si está disponible

---

## Datos

### Migrar de JSON a SQLite ✅
- Base de datos: `listening-history.db`
- Tablas: `songs`, `listen_dates`, `genre_cache`
- Queries eficientes con índices
- Script de migración: `node migrate.js`

### Registro de BPM por canción ✅
- Intenta MusicBrainz API (tags BPM de recordings)
- Fallback: estimación por duración de canción
- Tools: `ytm_stats` y CLI `yt-history bpm` lo muestran

---

## MCP — Nuevas Tools (Todas ✅)

| Tool | Descripción |
|------|-------------|
| `ytm_search_and_play` | Buscar + reproducir en un solo paso, devuelve metadata |
| `ytm_wrapped` | Resumen semanal/mensual tipo Spotify Wrapped |
| `ytm_similar_to` | Canciones parecidas (mismo artista + mismo género) |
| `ytm_obsessions` | Canciones que dominan tu escucha reciente |
| `ytm_vibe_play` | Mix automático según hora/día/género detectado |
| `ytm_discover_weekly` | Canciones nuevas de tus géneros favoritos |
| `ytm_revival` | Canciones que no escuchás hace N días |
| `ytm_fiesta_mode` | Activa crossfade y sube volumen si detecta alta energía |
| `ytm_weather_play` | Playlist según vibe (morning/afternoon/night/rainy/sunny/chill) |
| `ytm_lyrics` | Letra sincronizada de la canción actual |

---

## Frontend Web

### Dashboard Vue-style ✅
- Servidor HTTP en puerto 3456: `node dashboard-server.js` o `npm run dashboard`
- Carrusel de slides con stats, top artistas, top canciones, géneros, heatmap, distribución horaria, obsesiones y revival
- Colores: carbono negro (#0a0a0a) + verde radioactivo (#00ff41)
- Barra "now playing" en vivo
- Selector week/month para wrapped
- API REST: `/api/stats`, `/api/top-songs`, `/api/top-artists`, `/api/top-genres`, `/api/heatmap`, `/api/obsessions`, `/api/revival`, `/api/wrapped`, `/api/now`

### CLI — Nuevos comandos ✅
| Comando | Descripción |
|---------|-------------|
| `yt-history bpm [query]` | Ver BPM de canciones |
| `yt-history obsessions [n] [d]` | Canciones que más escuchás |
| `yt-history revival [days]` | Canciones olvidadas |
| `yt-history heatmap [days]` | Mapa de calor |
