# yt-music-mcp — Arquitectura del Sistema

> Sistema completo de tracking, análisis y control por IA de YouTube Music (th-ch/youtube-music), con contextualización ambiental, motor de recomendaciones, y análisis de audio vía Deezer + Essentia.js.

---

## 1. Visión General

```
┌────────────────────────────────────────────────────────────────────┐
│                         ECOSISTEMA                                  │
│                                                                    │
│  ┌──────────────┐   ┌───────────┐   ┌─────────────────────────┐   │
│  │  th-ch/yt-m  │──▶│  tracker  │──▶│   SQLite DB              │   │
│  │  (api-server)│◀──│  .js      │   │  (listening-history)     │   │
│  └──────────────┘   └───────────┘   └───┬────┬────┬────┬──────┘   │
│         ▲                                │    │    │    │          │
│         │ HTTP (26538)                   │    │    │    │          │
│         ▼                                ▼    ▼    ▼    ▼          │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                    MCP Server (stdio)                          │ │
│  │  51 tools · 2 prompts · stdio transport                       │ │
│  └────────────────────────────────────────────────────────────────┘ │
│         ▲                                                          │
│         │ stdio                                                     │
│         ▼                                                          │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │   IA / LLM (Claude, Gemini, etc.)                              │ │
│  │   Usa herramientas nativas: web_search + ytm_search            │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │   Dashboard Web (Vue 3) · http://0.0.0.0:3456                 │ │
│  │   Correlation matrix · scatter plots · week rhythm matrix     │ │
│  │   Hourly distribution · today live · BPM-synced now-dot       │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                    │
│  ┌──────────┐   ┌────────────────┐   ┌─────────────┐             │ │
│  │  Last.fm │   │  Open-Meteo    │   │  Deezer     │             │ │
│  │  (enrich)│   │  (weather)     │   │  + Essentia │             │ │
│  └──────────┘   └────────────────┘   │  (audio     │             │ │
│  ┌──────────┐   ┌──────────────┐     │   analysis) │             │ │
│  │features- │   │  webfetch    │     └─────────────┘             │ │
│  │ai.js     │   │  (discover)  │                                  │ │
│  └──────────┘   └──────────────┘                                  │ │
└────────────────────────────────────────────────────────────────────┘
```

---

## 2. Base de Datos (SQLite)

**Archivo:** `~/.var/app/com.github.th_ch.youtube_music/config/YouTube Music/listening-history.db`

### Tablas

#### `songs`
| Columna | Tipo | Descripción |
|---------|------|-------------|
| videoId | TEXT PK | YouTube video ID |
| title | TEXT | Título de la canción |
| artist | TEXT | Artista |
| album | TEXT | Álbum |
| duration | INTEGER | Duración en segundos |
| mediaType | TEXT | Tipo de contenido |
| genre | TEXT | Género (Last.fm / MusicBrainz / caché) |
| likeState | TEXT | LIKE / DISLIKE / INDIFFERENT |
| views | INTEGER | Vistas |
| playCount | INTEGER | Reproducciones totales |
| timesCompleted | INTEGER | Veces completada |
| maxProgress | REAL | Progreso máximo registrado (0-1) |
| bpm | REAL | Beats per minute |
| energy | REAL | Energía estimada (Last.fm tags / Deezer) |
| danceability | REAL | Bailabilidad (Last.fm tags / Deezer) |
| valence | REAL | Valencia/positividad (Last.fm tags / Deezer) |
| acousticness | REAL | Acousticidad (Deezer + Essentia.js) |
| firstListened | TEXT | Primera escucha (ISO) |
| lastListened | TEXT | Última escucha (ISO) |
| spotifyPopularity | INTEGER | Popularidad Deezer |
| spotifyTrackId | TEXT | ID del track en Deezer |
| spotifyEnergy | REAL | Energía (Deezer) |
| spotifyDanceability | REAL | Danceability (Deezer) |
| spotifyValence | REAL | Valencia (Deezer) |
| spotifyTempo | REAL | BPM (Deezer) |

#### `listen_dates`
| Columna | Tipo | Descripción |
|---------|------|-------------|
| id | INTEGER PK | Auto-increment |
| videoId | TEXT FK | → songs.videoId |
| listenedAt | TEXT | Timestamp ISO |
| progress | REAL | Progreso de esta escucha (0-1) |
| sessionId | TEXT | → sessions.id |
| activeApp | TEXT | Ventana activa detectada |
| keystrokeRate | REAL | Teclas por segundo |
| cpuLoad | REAL | Load average |
| memoryUsage | REAL | Fracción de memoria usada |
| weather | TEXT | JSON del clima (Open-Meteo) |

#### `sessions`
| Columna | Tipo | Descripción |
|---------|------|-------------|
| id | TEXT PK | `session_YYYYMMDDHHmmss` |
| startTime | TEXT | Inicio ISO |
| endTime | TEXT | Fin ISO (NULL si activa) |
| songCount | INTEGER | Canciones en la sesión |
| energyStart | REAL | Energía de la primera canción |
| energyEnd | REAL | Energía de la última canción |
| valenceStart | REAL | Valencia de la primera |
| valenceEnd | REAL | Valencia de la última |
| genreSequence | TEXT | JSON array de géneros |
| avgCpuLoad | REAL | CPU promedio durante sesión |
| weather | TEXT | JSON del clima |
| contextSummary | TEXT | Texto descriptivo generado |

#### `genre_cache`
| Columna | Tipo | Descripción |
|---------|------|-------------|
| artist | TEXT PK | Nombre del artista (lowercase) |
| genre | TEXT | Género resuelto |

#### `song_preferences`
| Columna | Tipo | Descripción |
|---------|------|-------------|
| id | INTEGER PK | Auto-increment |
| videoId | TEXT | → songs.videoId |
| title | TEXT | Título |
| artist | TEXT | Artista |
| emotional | TEXT | Conexión emocional |
| technical | TEXT | Análisis técnico |
| psychological | TEXT | Impacto psicológico |
| particular | TEXT | Particularidades |
| meaning | TEXT | Significado |
| lyricsSnippet | TEXT | Fragmento de letra |
| createdAt/updatedAt | TEXT | Timestamps |

---

## 3. Tracker (`tracker.js`)

**Propósito:** Daemon de background que monitorea la reproducción y registra el historial.

### Ciclo Principal
```
poll()
  │
  ├─ Auth (token Bearer)
  ├─ GET /api/v1/song → { videoId, title, artist, songDuration, elapsedSeconds }
  ├─ ¿Cambió la canción?
  │    ├─ Sí: Inicializa currentSong, dispara resolveGenre() + fetchBpm()
  │    └─ No: Actualiza maxProgress
  ├─ ¿progress ≥ THRESHOLD?
  │    ├─ Sí:
  │    │   ├─ collectContext() → activeApp, keystrokeRate, cpuLoad, memory, weather
  │    │   ├─ ¿Session activa? No → createSession(), Sí → updateSession()
  │    │   ├─ setTimeout 3s:
  │    │   │   ├─ db.upsertSong(songData)
  │    │   │   ├─ db.addListenDate(videoId, listenDate, context)
  │    │   │   ├─ lastfm.enrichSong() asíncrono (no bloquea)
  │    │   │   └─ Log a stdout
  │    └─ No: Solo trackea progreso
  ├─ ¿No hay cambio y session activa? → sessionInactiveCount++
  │    └─ ¿≥ SESSION_TIMEOUT_POLLS? → closeSession()
  └─ setTimeout(poll, POLL_INTERVAL)
```

### Contexto Recolectado
- **Ventana activa:** `busctl call` (GNOME/Wayland) → fallback `xdotool`
- **Teclado:** `/proc/interrupts` → diff count i8042 ÷ delta time
- **CPU:** `os.loadavg()[0]`
- **Memoria:** `1 - os.freemem() / os.totalmem()`
- **Clima:** Open-Meteo API → cache 30 min

### Enriquecimiento de Audio (Deezer + Essentia.js)
- Después de Last.fm enrichment, tracker llama a `deezer-audio.enrichSong()`
- **Flujo:** Deezer API (sin auth) → 30s preview MP3 → ffmpeg decode → PCM → Essentia.js WASM
- **Extrae:** BPM (autocorrelación + peak detection), energy (RMS), danceability (regularidad de intervalos), valence (brightness var), acousticness (spectral centroid + low energy ratio)
- **Fallback JS-only:** Para BPM y danceability (RhythmExtractor2013 causa crash WASM)
- **Backfill:** `backfill-spotify-audio.js` recorre canciones sin spotifyTrackId

### Resolución de Género (jerarquía)
1. `genre_cache` (caché por artista)
2. `KNOWN_GENRES` (mapa hardcodeado de ~50 artistas)
3. `extractGenreFromTags()` (tags de th-ch/yt-music)
4. `fetchGenreFromMusicBrainz()` (tags de artista)
5. `fetchGenreFromYtInnerTube()` (descripción del video YTM)

### Sesiones
- Se crean automáticamente al registrar la primera canción de una sesión
- Timeout: 30 polls (~60s) sin cambio de canción → se cierra
- Se captura: secuencia de géneros, energía, valencia, CPU, clima

---

## 4. MCP Server (`mcp-server.js`)

**Propósito:** Servidor MCP (Model Context Protocol) que expone 51 herramientas para que la IA controle YouTube Music y acceda al historial.

### Transporte
- **StdioServerTransport** — comunicación vía stdin/stdout
- Configuración en `opencode.jsonc` con timeout 600000ms

### Herramientas Completas

| Tool | Descripción |
|------|-------------|
| `ytm_now` | Canción actual (título, artista, progreso, like state) |
| `ytm_play_pause` | Pausar/reanudar |
| `ytm_next` | Siguiente canción |
| `ytm_previous` | Anterior canción |
| `ytm_search` | Buscar canciones en YTM |
| `ytm_play_song` | Reproducir por videoId o búsqueda |
| `ytm_queue` | Ver cola actual |
| `ytm_queue_add` | Añadir a cola (posición: end/next) |
| `ytm_queue_clear` | Limpiar cola |
| `ytm_like` | Dar like |
| `ytm_dislike` | Dar dislike |
| `ytm_volume` | Volumen 0-100 |
| `ytm_seek` | Adelantar/retroceder (segundos) |
| `ytm_history` | Historial de escucha |
| `ytm_stats` | Estadísticas completas |
| `ytm_recommend` | Recomendaciones por género/mood (YTM) |
| `ytm_play_recommendation` | Reproducir recomendación |
| `ytm_mix` | Mix personalizado en orden exacto |
| `ytm_playlist_start` | Iniciar radio desde canción |
| `ytm_search_and_play` | Buscar y reproducir |
| `ytm_wrapped` | Resumen semanal/mensual |
| `ytm_similar_to` | Canciones similares (distancia euclídea 5D) |
| `ytm_vibe_play` | Reproducir por vibra (energía/valencia) |
| `ytm_fiesta_mode` | Modo fiesta → canciones dance alto BPM |
| `ytm_weather_play` | Reproducir según clima real |
| `ytm_set_vibe` | Cambiar estado de ánimo global |
| `ytm_current_vibe` | Ver estado de ánimo actual |
| `ytm_complement` | Canción complementaria a la actual |
| `ytm_bridge` | Puente entre dos canciones |
| `ytm_song_details` | Detalles + BPM + energía de canción |
| `ytm_search_preferences` | Buscar preferencias guardadas |
| `ytm_get_preference` | Ver preferencia de canción |
| `ytm_save_preference` | Guardar preferencia emocional/técnica |
| `ytm_get_affinity_scores` | True Affinity Score |
| `ytm_get_safe_favorites` | Favoritos sin burnout |
| `ytm_get_sessions` | Historial de sesiones |
| `ytm_analyze_current_session_trajectory` | Trayectoria + predicción |
| `ytm_get_current_context` | Snapshot ambiental completo |
| `ytm_session_next` | Motor de recomendación contextual |
| `ytm_wait_for_song_change` | Esperar hasta que cambie la canción |
| `ytm_play_song_by_id` | Reproducir videoId vía GET |
| `ytm_search_video` | Buscar y devolver videoId |
| `ytm_flow_state` | Flow state songs (BPM/energy óptimos) |
| `ytm_mood_playlist` | Playlist por ánimo (happy/chill/energetic/focused/sad) |
| `ytm_burnout_report` | Diagnóstico de fatiga musical |
| `ytm_smart_playlist` | Clustering K-means++ 5D de canciones |
| `ytm_time_profile` | Perfil horario de preferencias auditivas |

### Prompt Templates
- **`music-recommendation`**: Pide recomendación con género/mood opcional
- **`user-context`**: Retorna todas las preferencias guardadas del usuario

### Sistema de Autenticación
```
POST /auth/{AUTH_ID} → { accessToken }
Bearer token → todas las peticiones a la API de th-ch/youtube-music
```

### Secuencia de Reproducción (3 pasos)
1. `DELETE /api/v1/queue` — limpiar cola
2. `POST /api/v1/queue { videoId, insertPosition: 'INSERT_AFTER_CURRENT_VIDEO' }`
3. `POST /api/v1/next` — saltar al siguiente

### Sistema de Búsqueda Serializada
- Mutex basado en promise chaining para evitar race conditions en búsquedas YTM concurrentes
- `serializedSearch()` → las búsquedas se encadenan secuencialmente

---

## 5. Motor de Recomendación (`ytm_session_next`)

### Modo `history` (default)
```
1. Obtener canción actual + sesión activa
2. Encontrar sesiones pasadas similares (misma hora ±2h, mismo género)
3. Identificar canciones que siguieron en esas sesiones
4. Puntuar candidatos por:
   - Affinity Score (playCount^0.5 × progress^1.5 × recencyBoost)
   - Mismo género que la actual (+3)
   - Mismo BPM (±20) (+2)
   - App category coincide con sesiones similares (+1.5)
   - Clima coincide (+1)
   - Excluir canciones fatigadas (burnout)
5. Queue de las mejores
```

### Modo `discover` (flujo externo)
```
1. Analizar contexto → perfil { vibe, genre, energyLevel, bpmRange }
2. Extraer topArtists + topGenres del usuario
3. Construir webQueries personalizadas (ej: "best chill acoustic songs similar to Måneskin")
4. RETORNAR searchBrief → la IA debe:
   a. Buscar en la web con sus búsquedas nativas
   b. Mostrar resultados al usuario
   c. PREGUNTAR: "las pongo después de la canción actual o arrancamos un mix ya?"
   d. Según respuesta: ytm_queue_add(position:"next") o ytm_mix()
```

---

## 6. Algoritmos de Personalización

### True Affinity Score
```
affinity = playCount^0.5 × avgProgress^1.5 × (1 + 0.3 × e^(-daysSinceLastListen / 30))
```
- Peso logarítmico al número de reproducciones
- Peso exponencial al progreso promedio
- Recency boost: +30% máximo, decae con media vida de 30 días

### Burnout Detection
- Regresión lineal sobre últimos progresos
- `slope < -0.02 && avgProgress < 0.7` → **fatigued**
- `slope < -0.01` → **declining**
- `else` → **healthy**
- Mínimo 3 data points

### Session Trajectory
- Regresión lineal sobre energía/valencia en la sesión
- Clasificaciones:
  - `ramping_up`: energía ↑ y valencia ↑
  - `winding_down`: energía ↓ y valencia ↓
  - `calming`: energía ↓ estable
  - `energizing`: energía ↑ agresiva
  - `stable`: sin tendencia significativa

### Categorización de Apps
- coding, terminal, browser, music, communication, office, file_manager, other

### Flow State Mejorado (`features-ai.getFlowStateSongs()`)
```
1. Determinar rango BPM según appCategory (coding: 80-130, reading: 60-100, etc.)
2. Filtrar canciones por:
   - BPM en rango óptimo (+3 pts)
   - Energía 0.35-0.7 (+2 pts), <0.35 (+1 pt)
   - Valencia ≥ 0.4 (+1.5 pts)
   - Acousticness > 0.5 para reading/terminal (+2 pts)
3. Bonus por likeState, Affinity Score
4. Penalizar fatiga (burnout: -8 pts fatigued, -2 declining)
```

### Modo Ánimo (`features-ai.getMoodSongs()`)
| Mood | Energy | Valence | BPM | Acousticness |
|------|--------|---------|-----|-------------|
| happy | 0.6–1.0 | 0.6–1.0 | 100–160 | 0–0.4 |
| chill | 0–0.4 | 0.3–0.8 | 50–100 | 0.4–1.0 |
| energetic | 0.7–1.0 | 0.3–1.0 | 120–200 | 0–0.3 |
| focused | 0.3–0.65 | 0.3–0.8 | 70–120 | 0.3–1.0 |
| sad | 0–0.4 | 0–0.35 | 40–90 | 0.3–1.0 |

Para cada canción cuenta cuántos rangos cumple (0–4). Las que cumplen todos ganan +2 bonus. Ordena por score descendente.

### K-Means++ Clustering (`features-ai.getSmartPlaylist()`)
- **Dimensiones:** 5D normalizadas [energy, danceability, valence, (bpm-60)/180, acousticness]
- **K:** min(4, totalSongs)
- **Inicialización:** K-means++ (distribución ponderada por distancia)
- **Nombres de cluster:** party, energy, chill, melancholic, acoustic, groovy, warm, intense, balanced, eclectic
- Las canciones se ordenan por affinity score dentro de cada cluster

### Perfil Temporal (`features-ai.getTimeProfile()`)
- JOIN listen_dates + songs para cada escucha con energía/valencia/BPM
- Agrupa por hora (0-23) y segmento (madrugada/mañana/tarde/noche)
- Retorna promedios por hora + segmento + hora pico

### Distancia Euclídea 5D (`features-ai.getSimilarSongs()`)
- `distance = √(Δenergy² + Δdanceability² + Δvalence² + Δbpm_norm² + Δacousticness²)`
- Si la canción objetivo no tiene features: fallback por género + artista
- Retorna las N más cercanas con distancia + affinity score

---

## 7. Enriquecimiento (Last.fm)

**Archivo:** `lastfm.js`

### Flujo
1. `track.getInfo` por artista + título
2. `artist.getInfo` para tags del artista
3. Merge de tags de canción y artista
4. `MOOD_MAP`: ~100 tags mapeados a { energy, danceability, valence }
5. `extractGenre()`: prioridad de ~50 géneros conocidos
6. Fallback a `spotify.js` (sin Premium, retorna null)

### MOOD_MAP parcial (clasificación ternaria)
| Rango energía | Tags |
|---|---|
| HIGH (0.7-0.95) | energetic, powerful, aggressive, heavy, loud, metal, hardcore |
| MEDIUM (0.35-0.75) | rock, pop, dance, electronic, indie, folk, jazz, hiphop, latin |
| LOW (0.1-0.35) | ambient, classical, lofi, sad, melancholic, chill, acoustic, piano |

**Cobertura:** 162/179 canciones (90.5%) con energía/valencia, 158 con acousticness vía Deezer.

---

## 7b. Análisis de Audio (Deezer + Essentia.js)

**Archivo:** `deezer-audio.js`

**Flujo:**
1. `searchTrack(artist, title)` → Deezer API (sin auth, 5s timeout)
2. `downloadPreview(url)` → 30s MP3 preview
3. `decodeToPcm(mp3, pcm)` → ffmpeg (22050Hz, mono, f32le)
4. `analyzePcm(pcmPath)`:
   - **BPM:** Autocorrelación de energía → pico en lag de beat → fallback a detección de picos RMS
     - Si BPM > 160, prueba sub-armónicos (skip=2,3,4) para evitar doblaje de octava
   - **Energy:** RMS promedio × 2.5 × factor de lowEnergyRatio
   - **Danceability:** Regularidad de intervalos entre picos RMS (coeficiente de variación)
   - **Valence:** 0.5 × (1 - brightnessVar) + 0.3 × (1 - lowEnergyRatio) + 0.2
   - **Acousticness:** 0.6 × (1 - spectralCentroid/4000) + 0.4 × lowEnergyRatio
   - **SpectralCentroid:** Essentia.js `SpectralCentroidTime` (WASM, no crash)

**Backfill:** `backfill-spotify-audio.js` — 170 canciones, 156 enriquecidas (~92%)

---

## 8. Dashboard Web

**Stack:** Vue 3 (CDN) + HTTP Server nativo Node.js

### Rutas API

| Ruta | Parámetros | Descripción |
|------|------------|-------------|
| `/api/stats` | `?period=today/week/month` | Estadísticas generales |
| `/api/top-songs` | `?period=...` | Top 10 canciones del período |
| `/api/top-artists` | `?period=...` | Top 10 artistas |
| `/api/top-genres` | `?period=...` | Top 10 géneros con barra |
| `/api/heatmap` | `?period=...` | Day×hour matrix + hourly distribution |
| `/api/today` | — | Canciones escuchadas hoy |
| `/api/now` | — | Canción reproduciéndose ahora (incluye BPM) |
| `/api/obsessions` | `?period=...` | Canciones obsesivas |
| `/api/revival` | — | Canciones sin escuchar >30d |
| `/api/correlations` | `?period=...` | Matriz de correlación (Pearson r) |
| `/api/scatter` | `?metricX,metricY,period` | Scatter plot + regresión lineal |

### Paneles del Dashboard
0. **Resumen** — stat cards (songs, plays, minutes, liked, days, sessions, bpm)
1. **Correlation Matrix** — heatmap de correlaciones + info-bar con interpretación
2. **Scatter Plot** — gráfico de dispersión + r², pendiente, intercepto
3. **Hourly Distribution** — panel completo (barras 0-23)
4. **Week Rhythm** — matriz 7×24 (día × hora) con intensidad verde
5. **Today Live** — canciones de hoy en vivo
6. **Sessions** — sesiones recientes con trayectoria
7. **Obsessions** — canciones más repetidas
8. **Revival** — canciones olvidadas
9. **Genres** — top géneros

**Ahora-playing dot:** Sincronizado al BPM de la canción actual mediante `animation-delay` negativo basado en `(elapsed × bpm / 60) % 1`.

**Period selector:** today / week / month — afecta correlaciones, scatter, heatmap, stats.

---

## 9. Scripts Auxiliares

### `analisis.js`
Reporte completo por consola:
- Stats generales
- Top 10 True Affinity Score con barra visual
- Burnout: canciones fatigadas + más sanas
- Últimas sesiones con trayectoria emocional
- Distribución horaria (barra ASCII)
- Canción favorita por momento del día (madrugada/mañana/tarde/noche)
- Safe Favorites para recomendaciones IA

### `backfill-sessions.js`
Backfill para datos históricos:
1. Rellena `progress` NULL con `maxProgress` (o estimación 0.8-0.99)
2. Agrupa listens por gaps de ≥30 minutos → sesiones
3. Inserta sesiones en tabla `sessions`
4. Asigna `sessionId` en `listen_dates`

Resultado: 190 progresos backfilleados, 5 sesiones históricas detectadas.

### `lastfm-enrich.js`
Enriquecimiento batch de canciones existentes via Last.fm.

### `export-dump.js`
Exportación JSON con filtros temporales (`:today`, `:day N`, `:week N`, `:month N`):
- Metadatos completos (fechas, totales)
- Top 10 artistas + top 10 géneros
- Cada canción con metadatos completos
- Patrones de escucha (hora, día, días más activos)
- Desglose de likes
- Perfil de estado de ánimo promedio

---

## 10. Arquitectura del Clima (Open-Meteo)

- **Endpoint:** `https://api.open-meteo.com/v1/forecast?latitude={LAT}&longitude={LON}&current_weather=true`
- **No requiere API key**
- **Ubicación:** Barinas, Venezuela (8.6206, -70.2310) configurable via `.env`
- **Cache:** 30 minutos (en tracker y MCP server)
- **Weather codes mapeados:** 0-99 → clear, cloudy, rain, thunderstorm, etc.
- **Uso:**
  - Tracker guarda en `listen_dates.weather` y `sessions.weather`
  - MCP server usa para `ytm_weather_play`, `ytm_session_next`, `ytm_get_current_context`

---

## 11. Archivos del Proyecto

| Archivo | Líneas | Propósito |
|---------|--------|-----------|
| `tracker.js` | 503 | Daemon de tracking en background |
| `mcp-server.js` | ~1620 | Servidor MCP con 51 herramientas |
| `db.js` | ~960 | Módulo de base de datos SQLite |
| `lastfm.js` | ~230 | Enriquecimiento vía Last.fm |
| `deezer-audio.js` | ~236 | Análisis de audio (Deezer + Essentia.js) |
| `features-ai.js` | ~380 | Algoritmos de personalización de IA |
| `spotify-audio.js` | 79 | Spotify (legacy, bloqueado) |
| `dashboard-server.js` | 180 | Servidor HTTP + API REST |
| `frontend/index.html` | ~410 | Dashboard Vue 3 (10+ paneles) |
| `analisis.js` | 124 | Reporte de análisis completo |
| `backfill-sessions.js` | 122 | Backfill de sesiones históricas |
| `backfill-spotify-audio.js` | 46 | Backfill de audio features (Deezer) |
| `export-dump.js` | 220 | Exportación JSON con filtros |
| `yt-history.js` | — | CLI para consultas |
| `lastfm-enrich.js` | — | Enriquecimiento batch |
| `.env.example` | 25 | Template de configuración |
| `package.json` | — | Dependencias |

---

## 12. Dependencias

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "better-sqlite3": "^12.11.1",
    "dotenv": "^17.4.2",
    "essentia.js": "^0.1.13"
  }
}
```

**System dependencies:** ffmpeg (decode MP3 → PCM para Essentia.js)

Sin frameworks web: HTTP server nativo, Vue 3 via CDN, SQLite directo.

---

## 13. Estado del Proyecto

### Completado
- [x] Tracker con contexto ambiental (ventana, teclado, CPU, RAM, clima)
- [x] SQLite con auto-migración de columnas
- [x] MCP server con 51 herramientas
- [x] True Affinity Score
- [x] Burnout Detection (fatiga musical) + auto-contexto en session_next
- [x] Session Clustering con trayectoria emocional
- [x] External Context + Weather
- [x] Dashboard Vue 3 (10+ paneles responsive)
- [x] Enriquecimiento Last.fm (~92% cobertura)
- [x] Motor de recomendación contextual (history + discover)
- [x] Sistema de sesiones con auto-detección y cierre
- [x] Backfill de datos históricos
- [x] Análisis completo por consola
- [x] Exportación JSON con filtros temporales + audio features
- [x] Modo discover delega búsqueda web a la IA
- [x] Confirmación obligatoria al usuario antes de encolar descubrimientos
- [x] Systemd services para tracker y dashboard
- [x] opencode.jsonc configurado (timeout 600s)
- [x] Correlación matriz con período (Pearson r)
- [x] Deezer audio analysis con Essentia.js WASM
- [x] BPM-synced now-playing dot en dashboard
- [x] Week rhythm (day×hour matrix)
- [x] Flow State Mejorado (BPM/energy/app-category)
- [x] Modo Ánimo (happy/chill/energetic/focused/sad)
- [x] K-Means++ Clustering 5D (smart playlist)
- [x] Perfil Temporal (hourly/segment profiles)
- [x] Distancia Euclídea 5D (similar songs)
- [x] ytm_session_next acepta mood param con feature ranges
- [x] Backfill de audio features vía Deezer (156/170 canciones)

### Pendiente
- Calibrar BPM extraction (RhythmExtractor2013 falla en WASM)
- Tests automatizados
- Mejora de cluster naming (más semántico)

---

## 14. Diagrama de Flujo de Datos

```
th-ch/youtube-music
    │ GET /api/v1/song (cada 2s)
    ▼
tracker.js ──► collectContext() ──► getActiveWindow()
    │                                getKeystrokeRate()
    │                                getCpuLoad()
    │                                getMemoryUsage()
    │                                getWeather() ──► Open-Meteo
    │
    ├─ progress ≥ threshold? ──► db.upsertSong() + db.addListenDate()
    │                                │
    │                                ├─► lastfm.enrichSong() (async → genre, energy, valence)
    │                                │      │
    │                                │      └─► db.updateSpotifyData()
    │                                │
    │                                └─► deezer-audio.enrichSong() (async → BPM, acousticness)
    │                                       │
    │                                       └─► Deezer API (30s preview)
    │                                           └─► ffmpeg decode → Essentia.js WASM
    │
    └─ song changed? ──► resolveGenre() (caché → KNOWN → tags → MusicBrainz → InnerTube)
                          fetchBpm() (MusicBrainz → estimación por duración)

MCP Server (stdio) ◄──► IA/LLM
    │                   │
    ├─ ytm_session_next ──► features.getBurnoutReport()
    │   history              + db.getAffinityScores() + db.getSafeFavorites()
    │                        + db.getSessionTrajectory()
    ├─ ytm_session_next ──► searchBrief → IA web_search → ytm_search → ytm_queue_add
    │   discover              (con mood profile si args.mood está set)
    ├─ ytm_flow_state ──► features.getFlowStateSongs(appCategory)
    ├─ ytm_mood_playlist ──► features.getMoodSongs(mood)
    ├─ ytm_burnout_report ──► features.getBurnoutReport()
    ├─ ytm_smart_playlist ──► features.getSmartPlaylist(cluster)
    ├─ ytm_time_profile ──► features.getTimeProfile()
    ├─ ytm_similar_to ──► features.getSimilarSongs(videoId) [euclidean 5D]
    ├─ ytm_get_current_context ──► getActiveWindow() + getWeather() + os.loadavg()
    ├─ ytm_analyze_current_session_trajectory ──► db.getSessionTrajectory()
    └─ ytm_mix ──► playVideoById() [clear → queue → next]

Dashboard HTTP ──► db queries (stats, top songs, correlations, scatter, day×hour, etc.)
    │
    └─► Vue 3 frontend (SPA, polling cada 5s/15s, BPM-synced now-dot)
```

---

## 15. Convenciones

- **Secrets/Puertos:** Solo en `.env` (no trackeado), `dotenv.config()` en cada JS
- **Variables de entorno clave:**
  - `YT_MUSIC_HOST`, `YT_MUSIC_PORT`, `YT_MUSIC_AUTH`
  - `LASTFM_API_KEY`, `LASTFM_API_SECRET`
  - `LATITUDE`, `LONGITUDE` (Open-Meteo)
  - `DASHBOARD_PORT` (default 3456)
  - `TRACKER_THRESHOLD` (default 45), `TRACKER_POLL_INTERVAL` (default 2000)
- **Formato de fechas:** ISO 8601 en toda la DB
- **Progreso:** Flotante 0.0–1.0
- **Energía/Valencia:** Flotante 0.0–1.0
