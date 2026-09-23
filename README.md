# @pipeworx/china-air-quality

Real-time nationwide air quality (空气质量) for China — AQI, pollutant levels and
concentrations (PM2.5, PM10, O3, NO2, SO2, CO), quality rating and monitoring-station
detail. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1663+ live data sources.

Of the 20 China-government sources probed 2026-09-07 (`docs/china-vertical-plan.md`
§2), this was the only one that answered clean JSON with no session cookie, Referer
trick or undocumented catalog id. No external demand asked for it in the prior 30
days; it is built because it is distinctive (nobody else serves CNEMC over MCP), not
because a question was waiting on it.

## Tools

- `china_air_quality(city)` — a city's current AQI, quality rating, primary
  pollutant, per-pollutant index level, and averaged station concentrations. Accepts
  an English city name ("Beijing"), a province ("Guangdong" resolves to its capital,
  Guangzhou), or the Chinese name directly ("北京市").
- `china_air_quality_ranking(direction?, n?, pollutant?)` — nationwide ranking of all
  338 CNEMC-monitored cities by AQI or by one pollutant's index level. `direction:
  "bottom"` (default) surfaces the most polluted; `"top"` the cleanest.
- `china_air_quality_stations(city)` — every individual monitoring station within one
  city, with its own AQI, concentrations and coordinates — the neighborhood-level view
  the city-wide summary averages over.

## Source

China National Environmental Monitoring Centre (中国环境监测总站), the government body
that operates China's official air-quality monitoring network:

- `https://air.cnemc.cn:18007/CityData/GetAllCityRealTimeAQIModels` — all 338 cities,
  refreshed hourly. Carries AQI and a 1-6 index **level** per pollutant, but no raw
  concentration.
- `https://air.cnemc.cn:18007/CityData/GetAQIDataPublishLive?cityName=<市名>` —
  station-level rows for one city, with actual pollutant concentrations (µg/m³, CO in
  mg/m³). `GetAQIDataPublishLives` (plural) is a dead path — it 404s.

`china_air_quality` merges both calls: city-level AQI/level/quality from the cached
all-cities feed, and averaged concentrations computed from that city's stations,
because the all-cities endpoint alone never carries a concentration value.

The all-cities payload (144 KB, hourly) is cached in-isolate for 10 minutes.

## City names — Chinese only on the upstream

CNEMC identifies every city by its Chinese administrative name; "Beijing" resolves
nowhere on the wire. `src/index.ts` bundles a generated table:

- **`CITY_EN_TO_ZH`** — Hanyu Pinyin romanization of all 338 published city names
  (administrative suffix 市/州/盟/地区/自治州 stripped), with a hand override for the
  handful whose common English spelling diverges from straight pinyin: Xi'an, Harbin,
  Urumqi, Lhasa, Hohhot, Ordos, Qiqihar, Hulunbuir.
- **`PROVINCE_TO_ZH`** — the 31 provinces/autonomous regions/municipalities (English
  and Chinese name) mapped to their capital city, so "air quality in Guangdong"
  resolves to Guangzhou.
- Chinese input is always accepted as-is against the 338 published names, with or
  without the trailing 市/州.

An unresolvable city name returns `found: false` with a hint rather than an upstream
error — CNEMC's own unknown-city response is a silent empty array, which would
otherwise read as "no pollution data" instead of "city not recognized".

## Known limits

- **Concentrations are a station average, not a single official number.** CNEMC
  publishes concentrations only at station grain; the city-level summary is this
  pack's average across that city's reporting stations for the current hour, stated
  in `pollutant_note` on every response.
- **A concentration below the sensor floor is excluded, not guessed.** CNEMC reports
  some readings as `<3` (below detection limit); those are dropped from the average
  rather than parsed as a wrong number.
- **MEE monthly city reports are HTML** and out of scope for this pack — see
  `docs/china-vertical-plan.md` §2 (filed separately as a research task).

## Auth

None.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "china-air-quality": {
      "url": "https://gateway.pipeworx.io/china-air-quality/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/china-air-quality/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1663+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/china_air_quality \
  -H 'Content-Type: application/json' \
  -d '{"city":"Beijing"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/china_air_quality`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "china-air-quality": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-china-air-quality"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-china-air-quality
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about China Air Quality data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
