# yt-music-mcp

MCP server + listening history tracker para [th-ch/youtube-music](https://github.com/th-ch/youtube-music).

Controlá YouTube Music desde opencode, Claude, o cualquier cliente MCP. Reproducí canciones, creá mixes, consultá estadísticas de escucha, y recibí recomendaciones basadas en tu historial real.

---

## Requisito

**th-ch/youtube-music** con el plugin **api-server** activado.

El api-server expone un HTTP API en `http://0.0.0.0:26538` (por defecto). Sin esto, el MCP server no puede conectarse.

En la UI de YT Music: `Plugins → api-server → enabled`. Si no aparece, agregalo en `config.json`:

```json
"plugins": {
  "api-server": {
    "enabled": true,
    "port": 26538
  }
}
```

---

## Instalación

```bash
git clone https://github.com/tuusuario/yt-music-mcp
cd yt-music-mcp
npm install
```

### Registrar en opencode

Agregá esto a `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "yt-music": {
      "type": "local",
      "command": ["node", "/ruta/a/yt-music-mcp/mcp-server.js"],
      "enabled": true,
      "timeout": 15000
    }
  }
}
```

Para otros clientes MCP (Claude Desktop, etc.), configurá el comando `node /ruta/a/yt-music-mcp/mcp-server.js`.

---

## Tools del MCP Server

### Reproducción

| Tool | Descripción |
|------|-------------|
| `ytm_now` | Canción actual: título, artista, álbum, progreso, like |
| `ytm_play_pause` | Pausar / reanudar |
| `ytm_next` | Siguiente tema |
| `ytm_previous` | Tema anterior |
| `ytm_play_song` | Reproducir por `videoId` o por `query` (búsqueda + play) |
| `ytm_mix` | Crear mix: limpiar cola, tocar 1ra, encolar resto en orden |
| `ytm_playlist_start` | Iniciar playlist/radio por `videoId` o `query` |
| `ytm_seek` | Adelantar/retroceder (segundos) |
| `ytm_volume` | Volumen 0–100 |

### Cola

| Tool | Descripción |
|------|-------------|
| `ytm_queue` | Ver cola actual |
| `ytm_queue_add` | Agregar canción (`position`: `end` o `next`) |
| `ytm_queue_clear` | Vaciar cola |

### Interacción

| Tool | Descripción |
|------|-------------|
| `ytm_like` | Dar like |
| `ytm_dislike` | Dar dislike |
| `ytm_search` | Buscar canciones, álbumes, playlists |

### Historial y Stats

| Tool | Descripción |
|------|-------------|
| `ytm_history` | Historial de escucha (filtrable: `recent`, `plays`, `liked`) |
| `ytm_stats` | Estadísticas: canciones totales, géneros, top artists |
| `ytm_recommend` | Recomendaciones basadas en tu historial real |

---

## Listening History Tracker

`tracker.js` se conecta al api-server de YT Music y registra automáticamente cada canción que supera el **45%** de reproducción.

### Trackea por canción:

- `title`, `artist`, `album`, `duration`
- `genre` (resuelto via: mapa local → MusicBrainz → InnerTube → cache)
- `likeState` (LIKE / DISLIKE / INDIFFERENT)
- `playCount`, `timesCompleted`
- `listenDates[]` con timestamp de cada vez que pasó el umbral
- Clasificación por fecha (`byDate`)

### Para activarlo:

```bash
systemctl --user enable --now $(pwd)/systemd/yt-music-history.service
```

O directamente:

```bash
node tracker.js
```

---

## CLI: `yt-history`

```bash
yt-history stats          # Estadísticas generales
yt-history list           # Canciones ordenadas por fecha
yt-history list plays     # Canciones ordenadas por reproducciones
yt-history top 10         # Top 10 más escuchadas
yt-history genres         # Desglose por género
yt-history search <q>     # Buscar en el historial
yt-history date YYYY-MM-DD  # Canciones de una fecha
yt-history watch          # Monitor en tiempo real
yt-history export         # JSON completo
```

---

## Mix Workflow

El secreto para crear mixes que suenen en orden: `ytm_mix` usa el workflow descubierto empíricamente:

1. Limpia la cola
2. Reproduce la primera canción
3. Encola el resto con `position=next` en **orden inverso**

Cada `queue_add` con `position=next` inserta justo después del tema actual. Insertando de atrás para adelante quedan en el orden correcto.

---

## Arquitectura

```
th-ch/youtube-music (api-server :26538)
        │
        ├── tracker.js ───→ listening-history.json
        │
        └── mcp-server.js ──→ opencode / Claude / cualquier cliente MCP
                                  │
                                  └── yt-history.js (CLI)
```

El tracker y el MCP server son independientes. Podés usar solo el MCP sin tracker, o solo el tracker sin MCP.

---

## ¿Por qué este repo?

- **Basado en la API nativa** de th-ch/youtube-music, no en scrapers frágiles
- **Recomendaciones con contexto real**: usa tu historial de escucha, no genéricas
- **Mix exacto**: el workflow `ytm_mix` garantiza el orden que pediste
- **Dual**: funciona como MCP server para IA y como CLI para humanos
