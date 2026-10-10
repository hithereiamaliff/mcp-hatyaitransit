# Hat Yai Transit MCP (MCP หาดใหญ่ทรานสิท)

**Language / ภาษา:** [English](#english) · [ภาษาไทย](#thai)

<a id="english"></a>

MCP (Model Context Protocol) server for public transport in **Hat Yai, Songkhla, southern Thailand**: the EV City Loop bus, the Hat Yai airport minibus and SRT trains to Padang Besar at the Malaysian border, with stop departures, fares and a journey planner. Answers come in English, Thai or Malay.

**MCP Endpoint:** `https://mcp.techmavie.digital/hatyaitransit/mcp`

**Data Source:** [Hat Yai Transit](https://hatyaitransit.techmavie.digital) public API ([developer docs and API keys](https://hatyaitransit.techmavie.digital/developers.html))

> **Unofficial.** Hat Yai Transit is an independent community app, not affiliated with or endorsed by Songkhla PAO, Airports of Thailand, SRT, KTMB, ViaBus or any operator. EV City Loop times at most stops are estimates, the airport minibus has no timetable, and there is no live vehicle tracking. Always confirm with the operator. Spotted wrong or outdated data? Tell me on [Threads](https://threads.com/@hiiialanhere).

## Table of Contents

- [What It Covers](#what-it-covers)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Available Tools](#available-tools)
- [AI Integration Guide](#ai-integration-guide)
- [Configuration](#configuration)
- [Getting an API Key](#getting-an-api-key)
- [Self-Hosting](#self-hosting)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Project Structure](#project-structure)
- [License](#license)

## What It Covers

| Route ID | Service | Times |
|----------|---------|-------|
| `HY3` | **EV City Loop, route 3** (Songkhla PAO): 24-stop loop around Hat Yai, both directions (Loop Left / Loop Right), 07:00–19:00 every 20–30 min. Free trial until 12 Nov 2026, then 15 THB flat. | Timetable from stop 1; **estimates** at other stops |
| `HY8299` | **Hat Yai airport minibus**: airport ↔ city centre ↔ Hat Yai Bus Terminal, 60–80 THB cash | **Hours only** (about 08:00–17:00), no timetable; departures from the airport follow flights |
| `SRT_741` | **SRT shuttle trains 741/743** (Hat Yai Junction → Padang Besar) and **742/744** (back), 50 THB, tickets only at the station counter from 2 h before departure | Scheduled |
| `SRT_SE45` | **SRT Special Express 45/46**, Hat Yai – Padang Besar section, book on SRT D-Ticket | Scheduled |
| `KTM_MYSAWASDEE` | **KTM MySawasdee** seasonal charter train, KL Sentral ↔ Hat Yai (information only, not used by the planner) | Scheduled, on running dates |

- All times are **Thailand time (GMT+7)**, one hour behind Malaysia and Singapore. Fares are in Thai baht (THB), with MYR equivalents in journey plans.
- Trips that go further into Malaysia or Singapore get a hand-off link to the sister apps [Malaysia Transit](https://malaysiatransit.techmavie.digital) and [SG-JB Transit](https://sgjbtransit.techmavie.digital).
- Live tracking is not part of the data: the tools point to the ViaBus app (buses) and SRT TTS-TrainView (trains).

## Architecture

```
AI assistant (Claude, ChatGPT, Cursor, ...)
    ↓ MCP (Streamable HTTP or stdio)
Hat Yai Transit MCP Server  (identifies itself as "Hat-Yai-Transit-MCP")
    ↓ HTTPS + X-API-Key (service key)
Hat Yai Transit API  (https://hatyaitransit.techmavie.digital)
```

- **Stateless:** every `POST /mcp` request gets a fresh MCP server and transport; nothing is shared between callers.
- **Compact answers:** the API returns every text in three languages plus map data. The tools pick one language and drop map-only fields (colours, kerb pins, polylines unless asked), and add short notes about estimated times and the minibus.
- **Client identification:** every API request carries `X-App-Name: Hat-Yai-Transit-MCP`, plus `X-API-Key` when a key is configured.

## Quick Start

### Connect to the hosted server

Add this to your MCP client configuration (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "hatyai-transit": {
      "transport": "streamable-http",
      "url": "https://mcp.techmavie.digital/hatyaitransit/mcp"
    }
  }
}
```

### Run it locally (stdio)

```bash
git clone https://github.com/hithereiamaliff/mcp-hatyaitransit.git
cd mcp-hatyaitransit
npm install
npm run build
```

```json
{
  "mcpServers": {
    "hatyai-transit": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-hatyaitransit/dist/stdio.js"],
      "env": {
        "HYT_API_KEY": "your-key-here (optional)"
      }
    }
  }
}
```

Without a key everything works except `plan_journey` and `search_places` (see [Getting an API Key](#getting-an-api-key)).

### Test with MCP Inspector

```bash
npx @modelcontextprotocol/inspector
# Select "Streamable HTTP" and enter https://mcp.techmavie.digital/hatyaitransit/mcp
# or, locally: npm run inspect
```

### Test with curl

```bash
# List all tools
curl -X POST https://mcp.techmavie.digital/hatyaitransit/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Next departures at Central Hat Yai
curl -X POST https://mcp.techmavie.digital/hatyaitransit/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_stop_departures","arguments":{"stopId":"HY3_19","count":5}}}'

# Plan a trip from the airport to Hat Yai Junction at 09:00
curl -X POST https://mcp.techmavie.digital/hatyaitransit/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"plan_journey","arguments":{"originText":"Hat Yai Airport","destinationStopId":"SRT_HAT_YAI","departAt":"09:00"}}}'
```

Answers are plain JSON (no event stream). Other endpoints: `GET /` (server info and tool list), `GET /health`, `GET /analytics` (in-memory usage counters).

## Available Tools

All tools are read-only. Most accept `language`: `en` (default), `th` or `ms`.

| Tool | What it does | API endpoint | Key needed |
|------|--------------|--------------|:----------:|
| `get_service_info` | Start here: routes, today's date in Thailand, EV fare period, time-status meanings, tracking links, disclaimer, planner availability | `GET /api/meta` | |
| `list_routes` | All routes with operator, hours, fare today, directions, train numbers | `GET /api/routes` | |
| `get_route` | One route: directions with ordered stops, all stops with coordinates, tickets, trains, running dates, known data gaps | `GET /api/routes/{routeId}` | |
| `get_route_departures` | Today's departures per direction (first stop or a given stop); upcoming only unless `includePast` | `GET /api/routes/{routeId}/departures` | |
| `search_stops` | Find stops by Thai/English name or alias ("Central", "HDY", "หอนาฬิกา") | `GET /api/stops/search` | |
| `get_stop` | One stop: names in 3 languages, coordinates, routes, aliases, boarding point per direction | `GET /api/stops/{stopId}` | |
| `find_nearby_stops` | Stops near lat/lng (or a `placeId`), with distance and rough walking time | `GET /api/stops/nearby` | |
| `get_stop_departures` | "When is the next bus/train here?" across all routes; minibus as operating hours | `GET /api/stops/{stopId}/departures` | |
| `get_fares` | Fares in force on a date (EV free trial vs 15 THB period) | `GET /api/fares` | |
| `plan_journey` | A → B journey options (bus, minibus, train, walking) with times, fares, tickets, warnings; hand-off links for trips into Malaysia/Singapore | `POST /api/journey/plan` (+ place search for text) | Yes |
| `search_places` | Landmarks, hotels, addresses → `placeId`s for `plan_journey` / `find_nearby_stops` | `GET /api/journey/places/autocomplete` (+ `/details`) | Yes (service key) |
| `list_gtfs_feeds` | Open GTFS feeds: versions, validity, download URLs, ODbL licence and attribution | `GET /api/gtfs/feeds` | |
| `get_sources` | Data sources (official / news), last checked dates, licences, disclaimer, where to report wrong data | `GET /api/sources` (+ `/api/meta`) | |
| `get_route_geometry` | Route line summary (points, length, bounding box); encoded polyline only on request | `GET /api/routes/{routeId}/geometry` | |

### `plan_journey` inputs

- **Origin / destination**: each as ONE of `originStopId`, `originLat` + `originLng`, `originPlaceId` (from `search_places`), or `originText` (a place name, resolved through place search; the answer shows how it was read and other matches). Same for `destination*`.
- `departAt`: `"HH:MM"` (today Thailand time, or tomorrow if that time has passed), `"YYYY-MM-DDTHH:MM"` (Thailand time), or a full ISO time with an offset. Default: now. Only "depart at" is supported.
- `includeBus`, `includeRail` (default `true`), `planPadangBesarMy` (plan trips ending on the Malaysian side of Padang Besar station here instead of handing off), `includeStops`, `includePolylines`, `language`.

Results: `status: "ok"` with up to 5 `journeys`, or `status: "handoff"` with a `handoffUrl`, or `status: "no-routes"` / `"area-out-of-coverage"` with a message to pass on.

## AI Integration Guide

| User asks | Tools |
|-----------|-------|
| "How do I get from the airport to Central?" | `plan_journey` (`originText: "Hat Yai Airport"`, `destinationText: "Central"`) |
| "When is the next EV bus at Central Festival?" | `search_stops` → `get_stop_departures` |
| "Train times to Padang Besar today?" | `get_route_departures` (`routeId: "SRT_741"`) |
| "How much is the airport minibus?" | `get_fares` |
| "Which stops are near my hotel?" | `find_nearby_stops` (lat/lng), or `search_places` → `find_nearby_stops` (`placeId`) |
| "Is this information official?" | `get_sources` |

Tips for models:

1. **Don't guess IDs.** Get stop IDs from `search_stops` / `find_nearby_stops` / `get_route`.
2. **Say when a time is an estimate.** `status: "estimated"` (EV loop away from stop 1) and `"hours-only"` (airport minibus) are not timetables.
3. **Relay hand-offs.** For trips into Malaysia or Singapore, share the `handoffUrl` instead of inventing a route.
4. **Mention the border trains' rules.** Shuttle tickets (741–744) are only sold at the station counter from 2 hours before departure; northbound trains are often late.
5. **Times are Thailand time (GMT+7).**

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `HYT_API_URL` | `https://hatyaitransit.techmavie.digital` | Hat Yai Transit API base URL |
| `HYT_API_KEY` | (empty) | API key sent as `X-API-Key`. Enables `plan_journey` (and `search_places` with the service key). Never logged or returned by any tool. |
| `HYT_API_TIMEOUT_MS` | `15000` | Timeout for each API request |
| `PORT` | `8080` | HTTP server port (HTTP mode only) |
| `HOST` | `0.0.0.0` | HTTP bind address (HTTP mode only) |

Copy `.env.example` to `.env` for local use.

## Getting an API Key

The API works without a key at **60 requests/minute per IP**, but without one the journey planner and place search are off.

- **Your own copy:** request a free developer key (`hyt_` + 32 hex characters) at [hatyaitransit.techmavie.digital/developers.html](https://hatyaitransit.techmavie.digital/developers.html). It raises the limit to 300 requests/minute and enables `plan_journey`. Place search (`search_places`, and text resolution inside `plan_journey`) stays off; use stop IDs or coordinates instead.
- **The hosted server** uses a *service key* that also allows place search. It is configured on the API server (`API_SERVICE_KEYS=mcp:<key>`) and passed to this server as `HYT_API_KEY` (see [deploy/DEPLOYMENT.md](./deploy/DEPLOYMENT.md)).

## Self-Hosting

```bash
# Docker (binds to 127.0.0.1:8101)
cp .env.example .env      # set HYT_API_KEY
docker network create mcp-network 2>/dev/null || true
docker compose up -d --build
curl http://127.0.0.1:8101/health

# Or directly with Node.js 22+
npm install
npm run build
npm start                 # HTTP on :8080
npm run start:stdio       # stdio
```

The production setup (nginx block, GitHub Actions auto-deploy, secrets) is described in [deploy/DEPLOYMENT.md](./deploy/DEPLOYMENT.md).

### Auto-Deployment

Every push to `main` runs the type-check, tests and build, then deploys to the VPS. Repository secrets: `VPS_HOST`, `VPS_USERNAME`, `VPS_SSH_KEY`, `VPS_PORT` (same as the other MCP servers) and `HYT_API_KEY`.

## Development

```bash
npm install
npm run dev          # HTTP server with auto-reload (tsx watch)
npm run dev:stdio    # stdio server from source
npm test             # unit tests (node:test via tsx; the API is mocked, no network)
npm run typecheck    # TypeScript checks for src and tests
npm run build        # compile to dist/
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `plan_journey` / `search_places` say HYT_API_KEY is not configured | Set `HYT_API_KEY` and restart |
| `invalid-api-key` | The key is wrong or revoked; get a new one |
| `rate-limited` | Wait `retryAfterSec`; set a key to raise the limit |
| `406 Not Acceptable` from another MCP server | This one accepts plain `Accept: application/json` too; for others send `Accept: application/json, text/event-stream` |
| A stop isn't found | Try the Thai name, a shorter name, or `find_nearby_stops` |
| Data looks wrong or out of date | Check `get_sources`, and report it on [Threads](https://threads.com/@hiiialanhere) |

## Project Structure

```
mcp-hatyaitransit/
├── src/
│   ├── http-server.ts    # Production entry point (Streamable HTTP)
│   ├── http-app.ts       # Express app: POST /mcp, /, /health, /analytics
│   ├── stdio.ts          # Local entry point (stdio)
│   ├── server.ts         # Creates an McpServer with all tools
│   ├── tools.ts          # The 14 tools
│   ├── api.ts            # Hat Yai Transit API client (fetch, timeout, errors)
│   ├── format.ts         # Language picking, compact output, notes, time helpers
│   ├── analytics.ts      # In-memory usage counters
│   ├── config.ts         # Settings and constants
│   └── env.ts            # Loads .env
├── tests/                # node:test suites (API client, tools, HTTP, helpers)
├── deploy/
│   ├── DEPLOYMENT.md     # VPS deployment guide
│   └── nginx-location.conf
├── .github/workflows/deploy-vps.yml
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

## Related Projects

- **[Malaysia Transit MCP](https://github.com/hithereiamaliff/mcp-malaysiatransit)**: buses and trains across Malaysia
- **[Hat Yai Transit](https://hatyaitransit.techmavie.digital)**: the web app this server reads from

## License

MIT - see [LICENSE](./LICENSE). Transit data from the Hat Yai Transit API is open data under the [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/); attribution: "Hat Yai Transit (unofficial) · © OpenStreetMap contributors · sources listed at https://hatyaitransit.techmavie.digital/sources.html".

---

<a id="thai"></a>

# ภาษาไทย

**Language / ภาษา:** [English](#english) · [ภาษาไทย](#thai)

เซิร์ฟเวอร์ MCP (Model Context Protocol) สำหรับระบบขนส่งสาธารณะใน**หาดใหญ่ จังหวัดสงขลา ภาคใต้ของประเทศไทย** ได้แก่ รถ EV รอบเมือง รถมินิบัสสนามบินหาดใหญ่ และรถไฟ รฟท. ไปปาดังเบซาร์ที่ชายแดนมาเลเซีย พร้อมเวลารถออกจากป้าย ค่าโดยสาร และระบบวางแผนการเดินทาง ตอบได้ทั้งภาษาอังกฤษ ไทย และมลายู

**MCP Endpoint:** `https://mcp.techmavie.digital/hatyaitransit/mcp`

**แหล่งข้อมูล:** API สาธารณะของ[หาดใหญ่ทรานสิท](https://hatyaitransit.techmavie.digital) ([เอกสารสำหรับนักพัฒนาและคีย์ API](https://hatyaitransit.techmavie.digital/developers.html))

> **ไม่เป็นทางการ** หาดใหญ่ทรานสิทเป็นแอปชุมชนอิสระ ไม่มีส่วนเกี่ยวข้องหรือได้รับการรับรองจาก อบจ.สงขลา ท่าอากาศยานไทย การรถไฟแห่งประเทศไทย KTMB ViaBus หรือผู้ให้บริการรายใด เวลาของรถ EV รอบเมืองที่ป้ายส่วนใหญ่เป็นเวลาประมาณการ รถมินิบัสสนามบินไม่มีตารางเวลา และไม่มีระบบติดตามตำแหน่งรถแบบเรียลไทม์ โปรดตรวจสอบกับผู้ให้บริการทุกครั้ง พบข้อมูลผิดหรือไม่เป็นปัจจุบัน? แจ้งได้ที่ [Threads](https://threads.com/@hiiialanhere)

## สารบัญ

- [ครอบคลุมอะไรบ้าง](#th-covers)
- [สถาปัตยกรรม](#th-architecture)
- [เริ่มต้นใช้งาน](#th-quick-start)
- [เครื่องมือที่มีให้ใช้](#th-tools)
- [คู่มือการเชื่อมต่อกับ AI](#th-ai-guide)
- [การตั้งค่า](#th-configuration)
- [การขอคีย์ API](#th-api-key)
- [ติดตั้งใช้งานเอง](#th-self-hosting)
- [การพัฒนา](#th-development)
- [การแก้ปัญหา](#th-troubleshooting)
- [โครงสร้างโปรเจกต์](#th-structure)
- [สัญญาอนุญาต](#th-license)

<a id="th-covers"></a>

## ครอบคลุมอะไรบ้าง

| รหัสเส้นทาง | บริการ | เวลา |
|----------|---------|-------|
| `HY3` | **รถ EV รอบเมือง สาย 3** (อบจ.สงขลา): วิ่งวนรอบหาดใหญ่ 24 ป้าย ทั้งสองทิศทาง (วนซ้าย / วนขวา) 07:00–19:00 ทุก 20–30 นาที นั่งฟรีช่วงทดลองถึง 12 พ.ย. 2569 จากนั้น 15 บาทตลอดสาย | ตารางเวลาจากป้ายที่ 1 ป้ายอื่นเป็น**เวลาประมาณการ** |
| `HY8299` | **รถมินิบัสสนามบินหาดใหญ่**: สนามบิน ↔ ใจกลางเมือง ↔ สถานีขนส่งหาดใหญ่ 60–80 บาท จ่ายเงินสด | **เฉพาะช่วงเวลาให้บริการ** (ประมาณ 08:00–17:00) ไม่มีตารางเวลา รถออกจากสนามบินตามเที่ยวบิน |
| `SRT_741` | **ขบวนรถไฟรับส่ง รฟท. 741/743** (ชุมทางหาดใหญ่ → ปาดังเบซาร์) และ **742/744** (ขากลับ) 50 บาท ซื้อตั๋วได้เฉพาะที่ช่องขายตั๋วของสถานี ก่อนรถออก 2 ชั่วโมง | ตามตารางเวลา |
| `SRT_SE45` | **รถด่วนพิเศษ รฟท. 45/46** ช่วงหาดใหญ่ – ปาดังเบซาร์ จองผ่าน SRT D-Ticket | ตามตารางเวลา |
| `KTM_MYSAWASDEE` | **KTM มายสวัสดี (MySawasdee)** รถไฟเช่าเหมาตามฤดูกาล KL Sentral ↔ หาดใหญ่ (แสดงเป็นข้อมูลเท่านั้น ระบบวางแผนการเดินทางไม่ใช้) | ตามตารางเวลา ในวันที่มีเดินรถ |

- เวลาทั้งหมดเป็น**เวลาประเทศไทย (GMT+7)** ช้ากว่ามาเลเซียและสิงคโปร์ 1 ชั่วโมง ค่าโดยสารเป็นเงินบาท (THB) และแผนการเดินทางจะแสดงค่าเทียบเป็นริงกิต (MYR) ด้วย
- การเดินทางที่ไปไกลเข้าไปในมาเลเซียหรือสิงคโปร์ จะได้ลิงก์ส่งต่อไปยังแอปพี่น้อง [Malaysia Transit](https://malaysiatransit.techmavie.digital) และ [SG-JB Transit](https://sgjbtransit.techmavie.digital)
- ข้อมูลไม่มีการติดตามรถแบบเรียลไทม์ เครื่องมือจะชี้ไปที่แอป ViaBus (รถโดยสาร) และ SRT TTS-TrainView (รถไฟ) แทน

<a id="th-architecture"></a>

## สถาปัตยกรรม

```
ผู้ช่วย AI (Claude, ChatGPT, Cursor, ...)
    ↓ MCP (Streamable HTTP หรือ stdio)
เซิร์ฟเวอร์ MCP หาดใหญ่ทรานสิท  (ระบุตัวเองว่า "Hat-Yai-Transit-MCP")
    ↓ HTTPS + X-API-Key (คีย์บริการ)
API หาดใหญ่ทรานสิท  (https://hatyaitransit.techmavie.digital)
```

- **ไม่เก็บสถานะ (stateless):** ทุกคำขอ `POST /mcp` จะได้เซิร์ฟเวอร์ MCP และ transport ใหม่ ไม่มีการแชร์ข้อมูลระหว่างผู้เรียกใช้
- **คำตอบกระชับ:** API ส่งข้อความทุกอย่างมาครบสามภาษาพร้อมข้อมูลแผนที่ เครื่องมือจะเลือกเพียงภาษาเดียว ตัดข้อมูลที่ใช้เฉพาะบนแผนที่ออก (สี ตำแหน่งจุดจอดริมถนน และ polyline เว้นแต่จะขอ) และเพิ่มหมายเหตุสั้น ๆ เรื่องเวลาประมาณการและรถมินิบัส
- **การระบุตัวไคลเอนต์:** ทุกคำขอไปยัง API จะส่ง `X-App-Name: Hat-Yai-Transit-MCP` และส่ง `X-API-Key` เมื่อมีการตั้งค่าคีย์ไว้

<a id="th-quick-start"></a>

## เริ่มต้นใช้งาน

### เชื่อมต่อกับเซิร์ฟเวอร์ที่เปิดให้บริการ

เพิ่มการตั้งค่านี้ในไคลเอนต์ MCP ของคุณ (Claude Desktop, Cursor, Windsurf ฯลฯ):

```json
{
  "mcpServers": {
    "hatyai-transit": {
      "transport": "streamable-http",
      "url": "https://mcp.techmavie.digital/hatyaitransit/mcp"
    }
  }
}
```

### รันบนเครื่องของคุณเอง (stdio)

```bash
git clone https://github.com/hithereiamaliff/mcp-hatyaitransit.git
cd mcp-hatyaitransit
npm install
npm run build
```

```json
{
  "mcpServers": {
    "hatyai-transit": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-hatyaitransit/dist/stdio.js"],
      "env": {
        "HYT_API_KEY": "your-key-here (optional)"
      }
    }
  }
}
```

หากไม่มีคีย์ ทุกอย่างยังใช้งานได้ ยกเว้น `plan_journey` และ `search_places` (ดู[การขอคีย์ API](#th-api-key))

### ทดสอบด้วย MCP Inspector

```bash
npx @modelcontextprotocol/inspector
# เลือก "Streamable HTTP" แล้วใส่ https://mcp.techmavie.digital/hatyaitransit/mcp
# หรือบนเครื่องตัวเอง: npm run inspect
```

### ทดสอบด้วย curl

```bash
# แสดงรายการเครื่องมือทั้งหมด
curl -X POST https://mcp.techmavie.digital/hatyaitransit/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# เที่ยวรถถัดไปที่เซ็นทรัล หาดใหญ่
curl -X POST https://mcp.techmavie.digital/hatyaitransit/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_stop_departures","arguments":{"stopId":"HY3_19","count":5}}}'

# วางแผนการเดินทางจากสนามบินไปสถานีชุมทางหาดใหญ่ เวลา 09:00
curl -X POST https://mcp.techmavie.digital/hatyaitransit/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"plan_journey","arguments":{"originText":"Hat Yai Airport","destinationStopId":"SRT_HAT_YAI","departAt":"09:00"}}}'
```

คำตอบเป็น JSON ธรรมดา (ไม่ใช่ event stream) endpoint อื่น ๆ: `GET /` (ข้อมูลเซิร์ฟเวอร์และรายการเครื่องมือ) `GET /health` และ `GET /analytics` (ตัวนับการใช้งานในหน่วยความจำ)

<a id="th-tools"></a>

## เครื่องมือที่มีให้ใช้

เครื่องมือทั้งหมดอ่านข้อมูลได้อย่างเดียว ส่วนใหญ่รับพารามิเตอร์ `language`: `en` (ค่าเริ่มต้น) `th` หรือ `ms`

| เครื่องมือ | ทำอะไร | API endpoint | ต้องใช้คีย์ |
|------|--------------|--------------|:----------:|
| `get_service_info` | เริ่มที่นี่: เส้นทาง วันที่ปัจจุบันตามเวลาประเทศไทย ช่วงค่าโดยสารรถ EV ความหมายของสถานะเวลา ลิงก์ติดตามรถ ข้อความชี้แจง และระบบวางแผนการเดินทางใช้ได้หรือไม่ | `GET /api/meta` | |
| `list_routes` | ทุกเส้นทาง พร้อมผู้ให้บริการ เวลาให้บริการ ค่าโดยสารวันนี้ ทิศทาง และหมายเลขขบวนรถไฟ | `GET /api/routes` | |
| `get_route` | เส้นทางเดียว: ทิศทางพร้อมป้ายตามลำดับ ป้ายทั้งหมดพร้อมพิกัด ตั๋ว ขบวนรถ วันเดินรถ และจุดที่ข้อมูลยังไม่ครบ | `GET /api/routes/{routeId}` | |
| `get_route_departures` | เที่ยวรถของวันนี้ในแต่ละทิศทาง (จากป้ายแรกหรือป้ายที่ระบุ) แสดงเฉพาะเที่ยวที่ยังไม่ออก เว้นแต่ระบุ `includePast` | `GET /api/routes/{routeId}/departures` | |
| `search_stops` | ค้นหาป้ายจากชื่อภาษาไทย/อังกฤษหรือชื่อเรียกอื่น ("Central", "HDY", "หอนาฬิกา") | `GET /api/stops/search` | |
| `get_stop` | ป้ายเดียว: ชื่อ 3 ภาษา พิกัด เส้นทาง ชื่อเรียกอื่น และจุดขึ้นรถในแต่ละทิศทาง | `GET /api/stops/{stopId}` | |
| `find_nearby_stops` | ป้ายใกล้พิกัด lat/lng (หรือ `placeId`) พร้อมระยะทางและเวลาเดินโดยประมาณ | `GET /api/stops/nearby` | |
| `get_stop_departures` | "รถ/รถไฟคันต่อไปมากี่โมง?" ครบทุกเส้นทาง รถมินิบัสแสดงเป็นช่วงเวลาให้บริการ | `GET /api/stops/{stopId}/departures` | |
| `get_fares` | ค่าโดยสารที่ใช้ในวันที่ระบุ (ช่วงทดลองนั่งฟรีของรถ EV หรือช่วง 15 บาท) | `GET /api/fares` | |
| `plan_journey` | ตัวเลือกการเดินทางจาก A → B (รถโดยสาร มินิบัส รถไฟ เดินเท้า) พร้อมเวลา ค่าโดยสาร ตั๋ว และคำเตือน มีลิงก์ส่งต่อสำหรับการเดินทางเข้ามาเลเซีย/สิงคโปร์ | `POST /api/journey/plan` (+ ค้นหาสถานที่สำหรับข้อความ) | ใช่ |
| `search_places` | สถานที่สำคัญ โรงแรม ที่อยู่ → `placeId` สำหรับใช้กับ `plan_journey` / `find_nearby_stops` | `GET /api/journey/places/autocomplete` (+ `/details`) | ใช่ (คีย์บริการ) |
| `list_gtfs_feeds` | ชุดข้อมูล GTFS แบบเปิด: เวอร์ชัน ช่วงวันที่ใช้ได้ ลิงก์ดาวน์โหลด สัญญาอนุญาต ODbL และการระบุที่มา | `GET /api/gtfs/feeds` | |
| `get_sources` | แหล่งข้อมูล (ทางการ / ข่าว) วันที่ตรวจสอบล่าสุด สัญญาอนุญาต ข้อความชี้แจง และช่องทางแจ้งข้อมูลผิด | `GET /api/sources` (+ `/api/meta`) | |
| `get_route_geometry` | สรุปแนวเส้นทาง (จำนวนจุด ความยาว กรอบพื้นที่) ส่ง encoded polyline เมื่อขอเท่านั้น | `GET /api/routes/{routeId}/geometry` | |

### ข้อมูลที่ `plan_journey` รับ

- **ต้นทาง / ปลายทาง**: ระบุอย่างใดอย่างหนึ่งต่อฝั่ง ได้แก่ `originStopId`, `originLat` + `originLng`, `originPlaceId` (จาก `search_places`) หรือ `originText` (ชื่อสถานที่ ระบบจะค้นหาให้ และคำตอบจะบอกว่าตีความชื่อนั้นอย่างไร พร้อมตัวเลือกอื่นที่ใกล้เคียง) ปลายทางใช้ `destination*` แบบเดียวกัน
- `departAt`: `"HH:MM"` (วันนี้ตามเวลาประเทศไทย หรือพรุ่งนี้หากเลยเวลานั้นไปแล้ว) `"YYYY-MM-DDTHH:MM"` (เวลาประเทศไทย) หรือเวลาแบบ ISO เต็มพร้อม offset ค่าเริ่มต้นคือเวลาปัจจุบัน รองรับเฉพาะ "ออกเดินทางเวลา" เท่านั้น
- `includeBus`, `includeRail` (ค่าเริ่มต้น `true`), `planPadangBesarMy` (วางแผนการเดินทางที่สิ้นสุดฝั่งมาเลเซียของสถานีปาดังเบซาร์ที่นี่เลย แทนการส่งต่อ), `includeStops`, `includePolylines`, `language`

ผลลัพธ์: `status: "ok"` พร้อม `journeys` สูงสุด 5 รายการ หรือ `status: "handoff"` พร้อม `handoffUrl` หรือ `status: "no-routes"` / `"area-out-of-coverage"` พร้อมข้อความให้ส่งต่อแก่ผู้ใช้

<a id="th-ai-guide"></a>

## คู่มือการเชื่อมต่อกับ AI

| ผู้ใช้ถาม | เครื่องมือ |
|-----------|-------|
| "จากสนามบินไปเซ็นทรัลยังไง?" | `plan_journey` (`originText: "Hat Yai Airport"`, `destinationText: "Central"`) |
| "รถ EV คันต่อไปที่เซ็นทรัลเฟสติวัลมากี่โมง?" | `search_stops` → `get_stop_departures` |
| "วันนี้รถไฟไปปาดังเบซาร์มีกี่โมงบ้าง?" | `get_route_departures` (`routeId: "SRT_741"`) |
| "มินิบัสสนามบินราคาเท่าไหร่?" | `get_fares` |
| "ป้ายไหนใกล้โรงแรมของฉัน?" | `find_nearby_stops` (lat/lng) หรือ `search_places` → `find_nearby_stops` (`placeId`) |
| "ข้อมูลนี้เป็นทางการไหม?" | `get_sources` |

คำแนะนำสำหรับโมเดล:

1. **อย่าเดารหัส** ให้เอารหัสป้ายจาก `search_stops` / `find_nearby_stops` / `get_route`
2. **บอกผู้ใช้เมื่อเวลาเป็นค่าประมาณ** `status: "estimated"` (รถ EV รอบเมืองที่ป้ายอื่นนอกจากป้ายที่ 1) และ `"hours-only"` (รถมินิบัสสนามบิน) ไม่ใช่ตารางเวลา
3. **ส่งต่อลิงก์ handoff** สำหรับการเดินทางเข้ามาเลเซียหรือสิงคโปร์ ให้แชร์ `handoffUrl` แทนการแต่งเส้นทางขึ้นเอง
4. **แจ้งกฎของรถไฟข้ามแดน** ตั๋วขบวนรับส่ง (741–744) ขายเฉพาะที่ช่องขายตั๋วของสถานี ก่อนรถออก 2 ชั่วโมง และขบวนขาขึ้นมักล่าช้า
5. **เวลาทั้งหมดเป็นเวลาประเทศไทย (GMT+7)**

<a id="th-configuration"></a>

## การตั้งค่า

| ตัวแปร | ค่าเริ่มต้น | คำอธิบาย |
|----------|---------|-------------|
| `HYT_API_URL` | `https://hatyaitransit.techmavie.digital` | URL หลักของ API หาดใหญ่ทรานสิท |
| `HYT_API_KEY` | (ว่าง) | คีย์ API ที่ส่งเป็น `X-API-Key` เปิดใช้ `plan_journey` (และ `search_places` เมื่อเป็นคีย์บริการ) ไม่ถูกบันทึกใน log และไม่มีเครื่องมือใดส่งคืนคีย์นี้ |
| `HYT_API_TIMEOUT_MS` | `15000` | เวลารอสูงสุดของแต่ละคำขอไปยัง API |
| `PORT` | `8080` | พอร์ตของเซิร์ฟเวอร์ HTTP (เฉพาะโหมด HTTP) |
| `HOST` | `0.0.0.0` | ที่อยู่ที่เซิร์ฟเวอร์ HTTP รอรับการเชื่อมต่อ (เฉพาะโหมด HTTP) |

คัดลอก `.env.example` เป็น `.env` เพื่อใช้งานบนเครื่องตัวเอง

<a id="th-api-key"></a>

## การขอคีย์ API

API ใช้งานได้โดยไม่ต้องมีคีย์ที่ **60 คำขอต่อนาทีต่อหมายเลข IP** แต่หากไม่มีคีย์ ระบบวางแผนการเดินทางและการค้นหาสถานที่จะปิดอยู่

- **สำหรับเซิร์ฟเวอร์ที่คุณรันเอง:** ขอคีย์นักพัฒนาฟรี (`hyt_` ตามด้วยเลขฐานสิบหก 32 ตัว) ได้ที่ [hatyaitransit.techmavie.digital/developers.html](https://hatyaitransit.techmavie.digital/developers.html) คีย์นี้เพิ่มขีดจำกัดเป็น 300 คำขอต่อนาทีและเปิดใช้ `plan_journey` ส่วนการค้นหาสถานที่ (`search_places` และการแปลงข้อความเป็นสถานที่ใน `plan_journey`) ยังคงปิดอยู่ ให้ใช้รหัสป้ายหรือพิกัดแทน
- **เซิร์ฟเวอร์ที่เปิดให้บริการ** ใช้*คีย์บริการ*ที่อนุญาตให้ค้นหาสถานที่ได้ด้วย คีย์นี้ตั้งค่าไว้ที่เซิร์ฟเวอร์ API (`API_SERVICE_KEYS=mcp:<key>`) และส่งให้เซิร์ฟเวอร์นี้ผ่าน `HYT_API_KEY` (ดู [deploy/DEPLOYMENT.md](./deploy/DEPLOYMENT.md))

<a id="th-self-hosting"></a>

## ติดตั้งใช้งานเอง

```bash
# Docker (เปิดที่ 127.0.0.1:8101)
cp .env.example .env      # ตั้งค่า HYT_API_KEY
docker network create mcp-network 2>/dev/null || true
docker compose up -d --build
curl http://127.0.0.1:8101/health

# หรือรันด้วย Node.js 22 ขึ้นไปโดยตรง
npm install
npm run build
npm start                 # HTTP ที่พอร์ต 8080
npm run start:stdio       # stdio
```

การตั้งค่าสำหรับใช้งานจริง (บล็อก nginx, GitHub Actions สำหรับ deploy อัตโนมัติ และ secrets) อธิบายไว้ใน [deploy/DEPLOYMENT.md](./deploy/DEPLOYMENT.md)

### Deploy อัตโนมัติ

ทุกครั้งที่ push ไปที่ `main` ระบบจะตรวจ type รันเทสต์ และ build จากนั้น deploy ไปยัง VPS โดยใช้ secrets ของ repository ได้แก่ `VPS_HOST`, `VPS_USERNAME`, `VPS_SSH_KEY`, `VPS_PORT` (เหมือนเซิร์ฟเวอร์ MCP ตัวอื่น) และ `HYT_API_KEY`

<a id="th-development"></a>

## การพัฒนา

```bash
npm install
npm run dev          # เซิร์ฟเวอร์ HTTP ที่รีโหลดอัตโนมัติ (tsx watch)
npm run dev:stdio    # เซิร์ฟเวอร์ stdio จากซอร์สโค้ด
npm test             # unit test (node:test ผ่าน tsx จำลอง API ไม่ใช้เครือข่าย)
npm run typecheck    # ตรวจ TypeScript ของ src และ tests
npm run build        # คอมไพล์ไปที่ dist/
```

<a id="th-troubleshooting"></a>

## การแก้ปัญหา

| ปัญหา | วิธีแก้ |
|---------|-----|
| `plan_journey` / `search_places` แจ้งว่ายังไม่ได้ตั้งค่า HYT_API_KEY | ตั้งค่า `HYT_API_KEY` แล้วรีสตาร์ต |
| `invalid-api-key` | คีย์ผิดหรือถูกยกเลิกแล้ว ให้ขอคีย์ใหม่ |
| `rate-limited` | รอตามเวลา `retryAfterSec` หรือตั้งค่าคีย์เพื่อเพิ่มขีดจำกัด |
| `406 Not Acceptable` จากเซิร์ฟเวอร์ MCP ตัวอื่น | เซิร์ฟเวอร์นี้รับ `Accept: application/json` อย่างเดียวได้ สำหรับตัวอื่นให้ส่ง `Accept: application/json, text/event-stream` |
| หาป้ายไม่เจอ | ลองชื่อภาษาไทย ชื่อที่สั้นลง หรือใช้ `find_nearby_stops` |
| ข้อมูลดูผิดหรือไม่เป็นปัจจุบัน | ตรวจสอบด้วย `get_sources` แล้วแจ้งได้ที่ [Threads](https://threads.com/@hiiialanhere) |

<a id="th-structure"></a>

## โครงสร้างโปรเจกต์

```
mcp-hatyaitransit/
├── src/
│   ├── http-server.ts    # จุดเริ่มต้นสำหรับใช้งานจริง (Streamable HTTP)
│   ├── http-app.ts       # แอป Express: POST /mcp, /, /health, /analytics
│   ├── stdio.ts          # จุดเริ่มต้นบนเครื่องตัวเอง (stdio)
│   ├── server.ts         # สร้าง McpServer พร้อมเครื่องมือทั้งหมด
│   ├── tools.ts          # เครื่องมือทั้ง 14 ตัว
│   ├── api.ts            # ไคลเอนต์ API หาดใหญ่ทรานสิท (fetch, timeout, ข้อผิดพลาด)
│   ├── format.ts         # เลือกภาษา ย่อผลลัพธ์ หมายเหตุ และตัวช่วยเรื่องเวลา
│   ├── analytics.ts      # ตัวนับการใช้งานในหน่วยความจำ
│   ├── config.ts         # การตั้งค่าและค่าคงที่
│   └── env.ts            # โหลด .env
├── tests/                # ชุดเทสต์ node:test (ไคลเอนต์ API, เครื่องมือ, HTTP, ตัวช่วย)
├── deploy/
│   ├── DEPLOYMENT.md     # คู่มือ deploy บน VPS
│   └── nginx-location.conf
├── .github/workflows/deploy-vps.yml
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

## โปรเจกต์ที่เกี่ยวข้อง

- **[Malaysia Transit MCP](https://github.com/hithereiamaliff/mcp-malaysiatransit)**: รถโดยสารและรถไฟทั่วมาเลเซีย
- **[หาดใหญ่ทรานสิท](https://hatyaitransit.techmavie.digital)**: เว็บแอปที่เซิร์ฟเวอร์นี้ดึงข้อมูลมา

<a id="th-license"></a>

## สัญญาอนุญาต

MIT ดูที่ [LICENSE](./LICENSE) ข้อมูลการเดินทางจาก API หาดใหญ่ทรานสิทเป็นข้อมูลเปิดภายใต้ [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/) โดยระบุที่มาว่า "Hat Yai Transit (unofficial) · © OpenStreetMap contributors · sources listed at https://hatyaitransit.techmavie.digital/sources.html"

---

Made by [Aliff](https://mynameisaliff.co.uk/) (TechMavie Digital), Penang. · สร้างโดย [Aliff](https://mynameisaliff.co.uk/) (TechMavie Digital) ปีนัง
