interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * Written as a sentence rather than a sigil because it is going to be read by
 * whoever gets the error, and "our own service, not a third party" is the
 * single most useful thing to tell them — fetchWithTimeout's own comment
 * (fleet #1047) is about exactly this ambiguity, where blaming a healthy vendor
 * by name sent the next person waiting for an outage that did not exist.
 */
const INTERNAL_ORIGIN_MARKER = ' [pipeworx-hosted origin — our own service, not a third party]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * China Air Quality MCP — nationwide hourly AQI from CNEMC (中国环境监测总站).
 * 中国空气质量实时数据 — AQI、PM2.5、PM10、O3、NO2、SO2、CO。
 *
 * Why this exists: of the 20 China-government sources probed 2026-09-07
 * (docs/china-vertical-plan.md §2), this is the ONLY one that answered clean
 * JSON, keyless, with no session cookie or Referer trick — every exchange and
 * registry API in the same probe needed a JSONP wrapper, an undocumented
 * catalog id, or is flatly blocked from a US IP. No external demand asked for
 * this in the last 30 days; it is built because it is distinctive (nobody
 * else serves CNEMC over MCP) and because it was the one clean win in the
 * batch.
 *
 * Source: China National Environmental Monitoring Centre (中国环境监测总站),
 * air.cnemc.cn — the same feed CNEMC's own public map draws from. Two
 * endpoints, both keyless:
 *   - GetAllCityRealTimeAQIModels: every city (338 rows), AQI + a 1-6 index
 *     LEVEL per pollutant (not a concentration), refreshed hourly.
 *   - GetAQIDataPublishLive?cityName=<市>: that city's individual monitoring
 *     STATIONS, each with actual pollutant concentrations (µg/m³, mg/m³ for
 *     CO) alongside its own AQI and levels.
 * `china_air_quality` merges both: the city-level AQI/level/quality from the
 * cheap cached call, and averaged concentrations computed from the station
 * call, because the all-cities endpoint alone never carries a raw
 * concentration value.
 *
 * City names are CHINESE ONLY on the upstream — "Beijing" resolves nowhere.
 * Below is a generated EN->中文 table (Hanyu Pinyin romanization of all 338
 * published city names, overridden for the handful whose common English
 * spelling diverges from straight pinyin — Xi'an, Harbin, Urumqi, Lhasa,
 * Hohhot, Ordos, Qiqihar, Hulunbuir) plus a province/region -> capital-city
 * alias table, so "Guangdong" resolves to Guangzhou. Chinese input is always
 * accepted as-is (exact match against the published name).
 */


/**
 * English <-> Chinese city-name table for CNEMC AQI lookups.
 *
 * CNEMC identifies cities ONLY by their Chinese administrative name (e.g.
 * "北京市"), so an English query ("Beijing", "beijing", "Xi'an") has to be
 * resolved before calling the upstream. CITY_EN_TO_ZH is generated from Hanyu
 * Pinyin romanization of the 338 prefecture-level city names CNEMC actually
 * publishes (administrative suffix 市/州/盟/地区/自治州 stripped),
 * with a small override table for cities whose common English spelling diverges
 * from straight pinyin (Xi'an, Harbin, Urumqi, Lhasa, Hohhot, Ordos, Qiqihar,
 * Hulunbuir).
 *
 * Five pairs of cities romanize identically without tone marks (Suzhou
 * 苏州/宿州, Fuzhou 福州/抚州, Taizhou 台州/泰州, Yichun 宜春/伊春, Yulin
 * 玉林/榆林). The plain key resolves to the better-known city in English usage;
 * the other is reachable only via a province-suffixed key (e.g. "taizhou-jiangsu")
 * or by passing the Chinese name directly.
 *
 * PROVINCE_TO_ZH maps a province/region name (English or Chinese) to its
 * capital city, so "air quality in Guangdong" resolves to Guangzhou.
 */

export const CITY_EN_TO_ZH: Record<string, string> = {
  "abazangzuqiangzu": "阿坝藏族羌族自治州",
  "akesu": "阿克苏地区",
  "alashan": "阿拉善盟",
  "aleitai": "阿勒泰地区",
  "ali": "阿里地区",
  "ankang": "安康市",
  "anqing": "安庆市",
  "anshan": "鞍山市",
  "anshun": "安顺市",
  "anyang": "安阳市",
  "baicheng": "白城市",
  "baise": "百色市",
  "baishan": "白山市",
  "baiyin": "白银市",
  "baoding": "保定市",
  "baoji": "宝鸡市",
  "baoshan": "保山市",
  "baotou": "包头市",
  "bayannaoer": "巴彦淖尔市",
  "bayinguolengmenggu": "巴音郭楞蒙古自治州",
  "bazhong": "巴中市",
  "beihai": "北海市",
  "beijing": "北京市",
  "bengbu": "蚌埠市",
  "benxi": "本溪市",
  "bijie": "毕节市",
  "binzhou": "滨州市",
  "boertalamenggu": "博尔塔拉蒙古自治州",
  "bozhou": "亳州市",
  "cangzhou": "沧州市",
  "changchun": "长春市",
  "changde": "常德市",
  "changdou": "昌都市",
  "changjihuizu": "昌吉回族自治州",
  "changsha": "长沙市",
  "changzhou": "常州市",
  "chaozhou": "潮州市",
  "chengde": "承德市",
  "chengdu": "成都市",
  "chenzhou": "郴州市",
  "chifeng": "赤峰市",
  "chizhou": "池州市",
  "chongqing": "重庆市",
  "chongzuo": "崇左市",
  "chuxiongyizu": "楚雄彝族自治州",
  "chuzhou": "滁州市",
  "dalian": "大连市",
  "dalibaizu": "大理白族自治州",
  "dandong": "丹东市",
  "danzhou": "儋州市",
  "daqing": "大庆市",
  "datong": "大同市",
  "daxinganling": "大兴安岭地区",
  "dazhou": "达州市",
  "dehongdaizujingpozu": "德宏傣族景颇族自治州",
  "deyang": "德阳市",
  "dezhou": "德州市",
  "dingxi": "定西市",
  "diqingzangzu": "迪庆藏族自治州",
  "dongguan": "东莞市",
  "dongying": "东营市",
  "enshitujiazumiaozu": "恩施土家族苗族自治州",
  "ezhou": "鄂州市",
  "fangchenggang": "防城港市",
  "foshan": "佛山市",
  "fushun": "抚顺市",
  "fuxin": "阜新市",
  "fuyang": "阜阳市",
  "fuzhou": "福州市",
  "fuzhou-jiangxi": "抚州市",
  "gannanzangzu": "甘南藏族自治州",
  "ganzhou": "赣州市",
  "ganzizangzu": "甘孜藏族自治州",
  "guangan": "广安市",
  "guangyuan": "广元市",
  "guangzhou": "广州市",
  "guigang": "贵港市",
  "guilin": "桂林市",
  "guiyang": "贵阳市",
  "guoluozangzu": "果洛藏族自治州",
  "guyuan": "固原市",
  "haibeizangzu": "海北藏族自治州",
  "haidong": "海东市",
  "haikou": "海口市",
  "hainanzangzu": "海南藏族自治州",
  "haiximengguzuzangzu": "海西蒙古族藏族自治州",
  "hami": "哈密市",
  "handan": "邯郸市",
  "hangzhou": "杭州市",
  "hanzhong": "汉中市",
  "harbin": "哈尔滨市",
  "hebi": "鹤壁市",
  "hechi": "河池市",
  "hefei": "合肥市",
  "hegang": "鹤岗市",
  "heihe": "黑河市",
  "hengshui": "衡水市",
  "hengyang": "衡阳市",
  "hetian": "和田地区",
  "heyuan": "河源市",
  "heze": "菏泽市",
  "hezhou": "贺州市",
  "hohhot": "呼和浩特市",
  "honghehanizuyizu": "红河哈尼族彝族自治州",
  "huaian": "淮安市",
  "huaibei": "淮北市",
  "huaihua": "怀化市",
  "huainan": "淮南市",
  "huanggang": "黄冈市",
  "huangnanzangzu": "黄南藏族自治州",
  "huangshan": "黄山市",
  "huangshi": "黄石市",
  "huizhou": "惠州市",
  "huludao": "葫芦岛市",
  "hulunbuir": "呼伦贝尔市",
  "huzhou": "湖州市",
  "jiamusi": "佳木斯市",
  "jian": "吉安市",
  "jiangmen": "江门市",
  "jiaozuo": "焦作市",
  "jiaxing": "嘉兴市",
  "jiayuguan": "嘉峪关市",
  "jieyang": "揭阳市",
  "jilin": "吉林市",
  "jinan": "济南市",
  "jinchang": "金昌市",
  "jincheng": "晋城市",
  "jingdezhen": "景德镇市",
  "jingmen": "荆门市",
  "jingzhou": "荆州市",
  "jinhua": "金华市",
  "jining": "济宁市",
  "jinzhong": "晋中市",
  "jinzhou": "锦州市",
  "jiujiang": "九江市",
  "jiuquan": "酒泉市",
  "jixi": "鸡西市",
  "kaifeng": "开封市",
  "kashi": "喀什地区",
  "kelamayi": "克拉玛依市",
  "kezileisukeerkezi": "克孜勒苏柯尔克孜自治州",
  "kunming": "昆明市",
  "laibin": "来宾市",
  "langfang": "廊坊市",
  "lanzhou": "兰州市",
  "leshan": "乐山市",
  "lhasa": "拉萨市",
  "liangshanyizu": "凉山彝族自治州",
  "lianyungang": "连云港市",
  "liaocheng": "聊城市",
  "liaoyang": "辽阳市",
  "liaoyuan": "辽源市",
  "lijiang": "丽江市",
  "lincang": "临沧市",
  "linfen": "临汾市",
  "linxiahuizu": "临夏回族自治州",
  "linyi": "临沂市",
  "linzhi": "林芝市",
  "lishui": "丽水市",
  "liupanshui": "六盘水市",
  "liuzhou": "柳州市",
  "longnan": "陇南市",
  "longyan": "龙岩市",
  "loudi": "娄底市",
  "luan": "六安市",
  "luoyang": "洛阳市",
  "luzhou": "泸州市",
  "lvliang": "吕梁市",
  "maanshan": "马鞍山市",
  "maoming": "茂名市",
  "meishan": "眉山市",
  "meizhou": "梅州市",
  "mianyang": "绵阳市",
  "mudanjiang": "牡丹江市",
  "nanchang": "南昌市",
  "nanchong": "南充市",
  "nanjing": "南京市",
  "nanning": "南宁市",
  "nanping": "南平市",
  "nantong": "南通市",
  "nanyang": "南阳市",
  "naqu": "那曲市",
  "neijiang": "内江市",
  "ningbo": "宁波市",
  "ningde": "宁德市",
  "nujianglisuzu": "怒江傈僳族自治州",
  "ordos": "鄂尔多斯市",
  "panjin": "盘锦市",
  "panzhihua": "攀枝花市",
  "pingdingshan": "平顶山市",
  "pingliang": "平凉市",
  "pingxiang": "萍乡市",
  "puer": "普洱市",
  "putian": "莆田市",
  "puyang": "濮阳市",
  "qiandongnanmiaozudongzu": "黔东南苗族侗族自治州",
  "qiannanbuyizumiaozu": "黔南布依族苗族自治州",
  "qianxinanbuyizumiaozu": "黔西南布依族苗族自治州",
  "qingdao": "青岛市",
  "qingyang": "庆阳市",
  "qingyuan": "清远市",
  "qinhuangdao": "秦皇岛市",
  "qinzhou": "钦州市",
  "qiqihar": "齐齐哈尔市",
  "qitaihe": "七台河市",
  "quanzhou": "泉州市",
  "qujing": "曲靖市",
  "quzhou": "衢州市",
  "rikaze": "日喀则市",
  "rizhao": "日照市",
  "sanmenxia": "三门峡市",
  "sanming": "三明市",
  "sanya": "三亚市",
  "shanghai": "上海市",
  "shangluo": "商洛市",
  "shangqiu": "商丘市",
  "shangrao": "上饶市",
  "shannan": "山南市",
  "shantou": "汕头市",
  "shanwei": "汕尾市",
  "shaoguan": "韶关市",
  "shaoxing": "绍兴市",
  "shaoyang": "邵阳市",
  "shenyang": "沈阳市",
  "shenzhen": "深圳市",
  "shihezi": "石河子市",
  "shijiazhuang": "石家庄市",
  "shiyan": "十堰市",
  "shizuishan": "石嘴山市",
  "shuangyashan": "双鸭山市",
  "shuozhou": "朔州市",
  "siping": "四平市",
  "songyuan": "松原市",
  "suihua": "绥化市",
  "suining": "遂宁市",
  "suizhou": "随州市",
  "suqian": "宿迁市",
  "suzhou": "苏州市",
  "suzhou-anhui": "宿州市",
  "tacheng": "塔城地区",
  "tahe": "漯河市",
  "taian": "泰安市",
  "taiyuan": "太原市",
  "taizhou": "台州市",
  "taizhou-jiangsu": "泰州市",
  "tangshan": "唐山市",
  "tianjin": "天津市",
  "tianshui": "天水市",
  "tieling": "铁岭市",
  "tongchuan": "铜川市",
  "tonghua": "通化市",
  "tongliao": "通辽市",
  "tongling": "铜陵市",
  "tongren": "铜仁市",
  "tulufan": "吐鲁番市",
  "urumqi": "乌鲁木齐市",
  "weifang": "潍坊市",
  "weihai": "威海市",
  "weinan": "渭南市",
  "wenshanzhuangzumiaozu": "文山壮族苗族自治州",
  "wenzhou": "温州市",
  "wuhai": "乌海市",
  "wuhan": "武汉市",
  "wuhu": "芜湖市",
  "wujiaqu": "五家渠市",
  "wulanchabu": "乌兰察布市",
  "wuwei": "武威市",
  "wuxi": "无锡市",
  "wuzhong": "吴忠市",
  "wuzhou": "梧州市",
  "xiamen": "厦门市",
  "xian": "西安市",
  "xiangtan": "湘潭市",
  "xiangxitujiazumiaozu": "湘西土家族苗族自治州",
  "xiangyang": "襄阳市",
  "xianning": "咸宁市",
  "xianyang": "咸阳市",
  "xiaogan": "孝感市",
  "xilinguolei": "锡林郭勒盟",
  "xingan": "兴安盟",
  "xingtai": "邢台市",
  "xining": "西宁市",
  "xinxiang": "新乡市",
  "xinyang": "信阳市",
  "xinyu": "新余市",
  "xinzhou": "忻州市",
  "xishuangbannadaizu": "西双版纳傣族自治州",
  "xuancheng": "宣城市",
  "xuchang": "许昌市",
  "xuzhou": "徐州市",
  "yaan": "雅安市",
  "yanan": "延安市",
  "yanbianchaoxianzu": "延边朝鲜族自治州",
  "yancheng": "盐城市",
  "yangjiang": "阳江市",
  "yangquan": "阳泉市",
  "yangzhou": "扬州市",
  "yantai": "烟台市",
  "yibin": "宜宾市",
  "yichang": "宜昌市",
  "yichun": "宜春市",
  "yichun-heilongjiang": "伊春市",
  "yilihasake": "伊犁哈萨克自治州",
  "yinchuan": "银川市",
  "yingkou": "营口市",
  "yingtan": "鹰潭市",
  "yiyang": "益阳市",
  "yongzhou": "永州市",
  "yueyang": "岳阳市",
  "yulin": "玉林市",
  "yulin-shaanxi": "榆林市",
  "yuncheng": "运城市",
  "yunfu": "云浮市",
  "yushuzangzu": "玉树藏族自治州",
  "yuxi": "玉溪市",
  "zaozhuang": "枣庄市",
  "zhangjiajie": "张家界市",
  "zhangjiakou": "张家口市",
  "zhangye": "张掖市",
  "zhangzhi": "长治市",
  "zhangzhou": "漳州市",
  "zhanjiang": "湛江市",
  "zhaoqing": "肇庆市",
  "zhaotong": "昭通市",
  "zhaoyang": "朝阳市",
  "zhengzhou": "郑州市",
  "zhenjiang": "镇江市",
  "zhongshan": "中山市",
  "zhongwei": "中卫市",
  "zhoukou": "周口市",
  "zhoushan": "舟山市",
  "zhuhai": "珠海市",
  "zhumadian": "驻马店市",
  "zhuzhou": "株洲市",
  "zibo": "淄博市",
  "zigong": "自贡市",
  "ziyang": "资阳市",
  "zunyi": "遵义市",
};

export const PROVINCE_TO_ZH: Record<string, string> = {
  "beijing": "北京市",
  "北京": "北京市",
  "tianjin": "天津市",
  "天津": "天津市",
  "hebei": "石家庄市",
  "河北": "石家庄市",
  "河北省": "石家庄市",
  "shanxi": "太原市",
  "山西": "太原市",
  "山西省": "太原市",
  "inner mongolia": "呼和浩特市",
  "内蒙古": "呼和浩特市",
  "内蒙古自治区": "呼和浩特市",
  "liaoning": "沈阳市",
  "辽宁": "沈阳市",
  "辽宁省": "沈阳市",
  "jilin": "长春市",
  "吉林": "长春市",
  "吉林省": "长春市",
  "heilongjiang": "哈尔滨市",
  "黑龙江": "哈尔滨市",
  "黑龙江省": "哈尔滨市",
  "shanghai": "上海市",
  "上海": "上海市",
  "jiangsu": "南京市",
  "江苏": "南京市",
  "江苏省": "南京市",
  "zhejiang": "杭州市",
  "浙江": "杭州市",
  "浙江省": "杭州市",
  "anhui": "合肥市",
  "安徽": "合肥市",
  "安徽省": "合肥市",
  "fujian": "福州市",
  "福建": "福州市",
  "福建省": "福州市",
  "jiangxi": "南昌市",
  "江西": "南昌市",
  "江西省": "南昌市",
  "shandong": "济南市",
  "山东": "济南市",
  "山东省": "济南市",
  "henan": "郑州市",
  "河南": "郑州市",
  "河南省": "郑州市",
  "hubei": "武汉市",
  "湖北": "武汉市",
  "湖北省": "武汉市",
  "hunan": "长沙市",
  "湖南": "长沙市",
  "湖南省": "长沙市",
  "guangdong": "广州市",
  "广东": "广州市",
  "广东省": "广州市",
  "guangxi": "南宁市",
  "广西": "南宁市",
  "广西壮族自治区": "南宁市",
  "hainan": "海口市",
  "海南": "海口市",
  "海南省": "海口市",
  "chongqing": "重庆市",
  "重庆": "重庆市",
  "sichuan": "成都市",
  "四川": "成都市",
  "四川省": "成都市",
  "guizhou": "贵阳市",
  "贵州": "贵阳市",
  "贵州省": "贵阳市",
  "yunnan": "昆明市",
  "云南": "昆明市",
  "云南省": "昆明市",
  "tibet": "拉萨市",
  "xizang": "拉萨市",
  "西藏": "拉萨市",
  "西藏自治区": "拉萨市",
  "shaanxi": "西安市",
  "陕西": "西安市",
  "陕西省": "西安市",
  "gansu": "兰州市",
  "甘肃": "兰州市",
  "甘肃省": "兰州市",
  "qinghai": "西宁市",
  "青海": "西宁市",
  "青海省": "西宁市",
  "ningxia": "银川市",
  "宁夏": "银川市",
  "宁夏回族自治区": "银川市",
  "xinjiang": "乌鲁木齐市",
  "新疆": "乌鲁木齐市",
  "新疆维吾尔自治区": "乌鲁木齐市",
};

/** All 338 valid CNEMC Chinese city names, for exact-match short-circuit. */
export const ALL_ZH_CITIES: string[] = [
  "七台河市",
  "三亚市",
  "三明市",
  "三门峡市",
  "上海市",
  "上饶市",
  "东莞市",
  "东营市",
  "中卫市",
  "中山市",
  "临夏回族自治州",
  "临汾市",
  "临沂市",
  "临沧市",
  "丹东市",
  "丽水市",
  "丽江市",
  "乌兰察布市",
  "乌海市",
  "乌鲁木齐市",
  "乐山市",
  "九江市",
  "云浮市",
  "五家渠市",
  "亳州市",
  "伊春市",
  "伊犁哈萨克自治州",
  "佛山市",
  "佳木斯市",
  "保定市",
  "保山市",
  "信阳市",
  "儋州市",
  "克孜勒苏柯尔克孜自治州",
  "克拉玛依市",
  "六安市",
  "六盘水市",
  "兰州市",
  "兴安盟",
  "内江市",
  "凉山彝族自治州",
  "包头市",
  "北京市",
  "北海市",
  "十堰市",
  "南京市",
  "南充市",
  "南宁市",
  "南平市",
  "南昌市",
  "南通市",
  "南阳市",
  "博尔塔拉蒙古自治州",
  "厦门市",
  "双鸭山市",
  "台州市",
  "合肥市",
  "吉安市",
  "吉林市",
  "吐鲁番市",
  "吕梁市",
  "吴忠市",
  "周口市",
  "呼伦贝尔市",
  "呼和浩特市",
  "和田地区",
  "咸宁市",
  "咸阳市",
  "哈密市",
  "哈尔滨市",
  "唐山市",
  "商丘市",
  "商洛市",
  "喀什地区",
  "嘉兴市",
  "嘉峪关市",
  "四平市",
  "固原市",
  "塔城地区",
  "大兴安岭地区",
  "大同市",
  "大庆市",
  "大理白族自治州",
  "大连市",
  "天水市",
  "天津市",
  "太原市",
  "威海市",
  "娄底市",
  "孝感市",
  "宁德市",
  "宁波市",
  "安庆市",
  "安康市",
  "安阳市",
  "安顺市",
  "定西市",
  "宜宾市",
  "宜昌市",
  "宜春市",
  "宝鸡市",
  "宣城市",
  "宿州市",
  "宿迁市",
  "山南市",
  "岳阳市",
  "崇左市",
  "巴中市",
  "巴彦淖尔市",
  "巴音郭楞蒙古自治州",
  "常州市",
  "常德市",
  "平凉市",
  "平顶山市",
  "广元市",
  "广安市",
  "广州市",
  "庆阳市",
  "廊坊市",
  "延安市",
  "延边朝鲜族自治州",
  "开封市",
  "张家口市",
  "张家界市",
  "张掖市",
  "徐州市",
  "德宏傣族景颇族自治州",
  "德州市",
  "德阳市",
  "忻州市",
  "怀化市",
  "怒江傈僳族自治州",
  "恩施土家族苗族自治州",
  "惠州市",
  "成都市",
  "扬州市",
  "承德市",
  "抚州市",
  "抚顺市",
  "拉萨市",
  "揭阳市",
  "攀枝花市",
  "文山壮族苗族自治州",
  "新乡市",
  "新余市",
  "无锡市",
  "日喀则市",
  "日照市",
  "昆明市",
  "昌吉回族自治州",
  "昌都市",
  "昭通市",
  "晋中市",
  "晋城市",
  "普洱市",
  "景德镇市",
  "曲靖市",
  "朔州市",
  "朝阳市",
  "本溪市",
  "来宾市",
  "杭州市",
  "松原市",
  "林芝市",
  "果洛藏族自治州",
  "枣庄市",
  "柳州市",
  "株洲市",
  "桂林市",
  "梅州市",
  "梧州市",
  "楚雄彝族自治州",
  "榆林市",
  "武威市",
  "武汉市",
  "毕节市",
  "永州市",
  "汉中市",
  "汕头市",
  "汕尾市",
  "江门市",
  "池州市",
  "沈阳市",
  "沧州市",
  "河池市",
  "河源市",
  "泉州市",
  "泰安市",
  "泰州市",
  "泸州市",
  "洛阳市",
  "济南市",
  "济宁市",
  "海东市",
  "海北藏族自治州",
  "海南藏族自治州",
  "海口市",
  "海西蒙古族藏族自治州",
  "淄博市",
  "淮北市",
  "淮南市",
  "淮安市",
  "深圳市",
  "清远市",
  "温州市",
  "渭南市",
  "湖州市",
  "湘潭市",
  "湘西土家族苗族自治州",
  "湛江市",
  "滁州市",
  "滨州市",
  "漯河市",
  "漳州市",
  "潍坊市",
  "潮州市",
  "濮阳市",
  "烟台市",
  "焦作市",
  "牡丹江市",
  "玉林市",
  "玉树藏族自治州",
  "玉溪市",
  "珠海市",
  "甘南藏族自治州",
  "甘孜藏族自治州",
  "白城市",
  "白山市",
  "白银市",
  "百色市",
  "益阳市",
  "盐城市",
  "盘锦市",
  "眉山市",
  "石嘴山市",
  "石家庄市",
  "石河子市",
  "福州市",
  "秦皇岛市",
  "红河哈尼族彝族自治州",
  "绍兴市",
  "绥化市",
  "绵阳市",
  "聊城市",
  "肇庆市",
  "自贡市",
  "舟山市",
  "芜湖市",
  "苏州市",
  "茂名市",
  "荆州市",
  "荆门市",
  "莆田市",
  "菏泽市",
  "萍乡市",
  "营口市",
  "葫芦岛市",
  "蚌埠市",
  "衡水市",
  "衡阳市",
  "衢州市",
  "襄阳市",
  "西双版纳傣族自治州",
  "西宁市",
  "西安市",
  "许昌市",
  "贵港市",
  "贵阳市",
  "贺州市",
  "资阳市",
  "赣州市",
  "赤峰市",
  "辽源市",
  "辽阳市",
  "达州市",
  "运城市",
  "连云港市",
  "迪庆藏族自治州",
  "通化市",
  "通辽市",
  "遂宁市",
  "遵义市",
  "邢台市",
  "那曲市",
  "邯郸市",
  "邵阳市",
  "郑州市",
  "郴州市",
  "鄂尔多斯市",
  "鄂州市",
  "酒泉市",
  "重庆市",
  "金华市",
  "金昌市",
  "钦州市",
  "铁岭市",
  "铜仁市",
  "铜川市",
  "铜陵市",
  "银川市",
  "锡林郭勒盟",
  "锦州市",
  "镇江市",
  "长春市",
  "长沙市",
  "长治市",
  "阜新市",
  "阜阳市",
  "防城港市",
  "阳江市",
  "阳泉市",
  "阿克苏地区",
  "阿勒泰地区",
  "阿坝藏族羌族自治州",
  "阿拉善盟",
  "阿里地区",
  "陇南市",
  "随州市",
  "雅安市",
  "青岛市",
  "鞍山市",
  "韶关市",
  "马鞍山市",
  "驻马店市",
  "鸡西市",
  "鹤壁市",
  "鹤岗市",
  "鹰潭市",
  "黄冈市",
  "黄南藏族自治州",
  "黄山市",
  "黄石市",
  "黑河市",
  "黔东南苗族侗族自治州",
  "黔南布依族苗族自治州",
  "黔西南布依族苗族自治州",
  "齐齐哈尔市",
  "龙岩市",
];

const UA = 'pipeworx-mcp/1.0 (bruce@mojibake.ai)';
const BASE = 'https://air.cnemc.cn:18007/CityData';

async function pwFetch(url: string): Promise<Response> {
  return fetchWithTimeout(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }, 'CNEMC');
}

// ── Types (subset of fields we actually use) ──────────────────────────

interface CityRow {
  TimePoint: string;
  AQI: string;
  COLevel: number;
  NO2Level: number;
  O3Level: number;
  PM10Level: number;
  PM2_5Level: number;
  SO2Level: number;
  Area: string;
  CityCode: number;
  AqiLevel: number;
  PrimaryPollutant: string;
  Quality: string;
  Measure: string;
  Latitude: string;
  Longitude: string;
}

interface StationRow {
  TimePoint: string;
  Area: string;
  PositionName: string;
  StationCode: string;
  CO: string;
  NO2: string;
  O3: string;
  O3_8h: string;
  PM10: string;
  PM2_5: string;
  SO2: string;
  AQI: string;
  AqiLevel?: number;
  PrimaryPollutant: string;
  Quality: string;
  Latitude: string;
  Longitude: string;
}

// ── City-name resolution ───────────────────────────────────────────────

const ZH_SET = new Set(ALL_ZH_CITIES);

/** Resolve a caller-supplied city (English, pinyin, or 中文) to the exact
 *  Chinese administrative name CNEMC publishes, or null if unresolvable. */
function resolveCity(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (ZH_SET.has(raw)) return raw;
  // A caller may drop the trailing 市/州, e.g. "上海" for "上海市".
  const withShi = `${raw}市`;
  if (ZH_SET.has(withShi)) return withShi;
  const key = raw.toLowerCase().replace(/[\s'-]/g, '');
  if (CITY_EN_TO_ZH[key]) return CITY_EN_TO_ZH[key];
  const provinceKey = raw.toLowerCase().trim();
  if (PROVINCE_TO_ZH[provinceKey]) return PROVINCE_TO_ZH[provinceKey];
  return null;
}

const QUALITY_EN: Record<string, string> = {
  优: 'Excellent',
  良: 'Good',
  轻度污染: 'Light Pollution',
  中度污染: 'Moderate Pollution',
  重度污染: 'Heavy Pollution',
  严重污染: 'Severe Pollution',
};

const POLLUTANT_LABELS: Record<string, string> = {
  pm2_5: 'PM2.5',
  pm10: 'PM10',
  o3: 'O3 (ozone)',
  no2: 'NO2',
  so2: 'SO2',
  co: 'CO',
};

// ── In-isolate cache of the all-cities call (10 min TTL) ────────────────
// 144 KB, published hourly by CNEMC — no reason to re-fetch it for every
// lookup. Nothing here is caller-specific.
const ALL_CITIES_TTL_MS = 10 * 60 * 1000;
let allCitiesCache: { rows: CityRow[]; byArea: Map<string, CityRow>; expiresAt: number } | null = null;

async function allCities(): Promise<{ rows: CityRow[]; byArea: Map<string, CityRow> }> {
  if (allCitiesCache && allCitiesCache.expiresAt > Date.now()) return allCitiesCache;
  const res = await pwFetch(`${BASE}/GetAllCityRealTimeAQIModels`);
  if (!res.ok) throw await httpError(res, 'CNEMC (GetAllCityRealTimeAQIModels)');
  const rows = await parseJson<CityRow[]>(res, 'CNEMC (GetAllCityRealTimeAQIModels)');
  const byArea = new Map<string, CityRow>();
  for (const r of rows) byArea.set(r.Area, r);
  allCitiesCache = { rows, byArea, expiresAt: Date.now() + ALL_CITIES_TTL_MS };
  return allCitiesCache;
}

async function stationsFor(cityZh: string): Promise<StationRow[]> {
  const res = await pwFetch(`${BASE}/GetAQIDataPublishLive?cityName=${encodeURIComponent(cityZh)}`);
  if (!res.ok) throw await httpError(res, 'CNEMC (GetAQIDataPublishLive)');
  // An unrecognized city name is a 200 with a literal `[]` body, not an error
  // — parseJson accepts that fine, and the caller-facing `found: false`
  // message (see resolveCity / the no_stations_reported branch below) is
  // what actually explains an empty result.
  return parseJson<StationRow[]>(res, 'CNEMC (GetAQIDataPublishLive)');
}

/** Average a numeric station field, skipping "NA" and "<N" detection-limit
 *  values (CNEMC reports e.g. PM2.5 as "<3" below the sensor floor — the
 *  concentration is real but not exactly readable, so it is dropped from the
 *  average rather than parsed as a wrong number). */
function avgField(stations: StationRow[], field: keyof StationRow): number | null {
  const vals: number[] = [];
  for (const s of stations) {
    const raw = s[field];
    if (typeof raw !== 'string' || raw === 'NA' || raw.startsWith('<')) continue;
    const n = Number(raw);
    if (Number.isFinite(n)) vals.push(n);
  }
  if (vals.length === 0) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

function cityLabel(zh: string): { zh: string; en: string | null } {
  // Reverse-lookup: prefer the pinyin table so the label round-trips even
  // when the caller supplied 中文 directly.
  for (const [en, mapped] of Object.entries(CITY_EN_TO_ZH)) {
    if (mapped === zh) return { zh, en: en.replace(/\b\w/g, (c) => c.toUpperCase()) };
  }
  return { zh, en: null };
}

// ── Tools ────────────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'china_air_quality',
    description:
      'Real-time air quality (空气质量) for a Chinese city — AQI, pollutant levels and concentrations (PM2.5, PM10, O3, NO2, SO2, CO), quality rating, primary pollutant and station count. Accepts an English city name ("Beijing", "Shanghai"), a province name ("Guangdong" resolves to Guangzhou), or the Chinese name ("北京市"). Answers "what is the air quality in Beijing right now", "is Shanghai\'s air safe today", "PM2.5 in Chengdu". Sourced from China National Environmental Monitoring Centre (中国环境监测总站), refreshed hourly.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        city: {
          type: 'string',
          description: 'City or province name, English or Chinese, e.g. "Beijing", "beijing", "北京市", "Guangdong".',
        },
      },
      required: ['city'],
    },
  },
  {
    name: 'china_air_quality_ranking',
    description:
      'Nationwide ranking of Chinese cities by air quality (空气质量排名) — the cleanest or most polluted cities right now, optionally ranked by a specific pollutant instead of overall AQI. Answers "which Chinese cities have the worst air quality today", "cleanest cities in China right now", "top 10 most polluted cities in China by PM2.5". Covers all 338 CNEMC-monitored prefecture-level cities.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        direction: {
          type: 'string',
          enum: ['top', 'bottom'],
          description: '"top" = cleanest (lowest AQI) first; "bottom" = most polluted (highest AQI) first. Default "bottom".',
        },
        n: { type: 'number', description: 'How many cities to return, 1-50 (default 10).' },
        pollutant: {
          type: 'string',
          enum: ['pm2_5', 'pm10', 'o3', 'no2', 'so2', 'co'],
          description: 'Rank by this pollutant\'s index level instead of overall AQI.',
        },
      },
    },
  },
  {
    name: 'china_air_quality_stations',
    description:
      'Individual monitoring-station readings (监测站点数据) within one Chinese city — every station\'s AQI, pollutant concentrations and quality rating, with station name and coordinates. Use this for neighborhood-level detail within a city, e.g. "which part of Shanghai has the worst air right now" or "list the air monitoring stations in Beijing". Accepts an English or Chinese city name.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        city: {
          type: 'string',
          description: 'City name, English or Chinese, e.g. "Shanghai", "上海市".',
        },
      },
      required: ['city'],
    },
  },
];

// ── Implementations ─────────────────────────────────────────────────

async function cityAirQuality(args: Record<string, unknown>) {
  const cityArg = typeof args.city === 'string' ? args.city : '';
  const zh = resolveCity(cityArg);
  if (!zh) {
    return {
      found: false,
      reason: 'city_not_recognized',
      queried: cityArg,
      hint: 'CNEMC publishes only its own 338 prefecture-level cities plus Beijing/Shanghai/Tianjin/Chongqing as municipalities. Try the English name of a major city ("Beijing", "Shenzhen"), a province ("Guangdong"), or the Chinese name directly ("北京市").',
    };
  }

  const { byArea } = await allCities();
  const city = byArea.get(zh);
  if (!city) {
    return {
      found: false,
      reason: 'city_resolved_but_not_in_current_feed',
      queried: cityArg,
      resolved_to: zh,
      hint: 'This city name resolved but was not present in the current CNEMC feed — the source may have renamed or dropped it. Try a neighboring city or the province.',
    };
  }

  const stations = await stationsFor(zh);
  const label = cityLabel(zh);

  const primary = city.PrimaryPollutant && city.PrimaryPollutant !== '—' ? city.PrimaryPollutant : null;

  return {
    found: true,
    city: label,
    as_of: city.TimePoint,
    aqi: Number(city.AQI) || null,
    aqi_level: city.AqiLevel,
    quality: city.Quality,
    quality_en: QUALITY_EN[city.Quality] ?? null,
    primary_pollutant: primary,
    health_guidance: city.Measure || null,
    pollutants: {
      pm2_5: { level: city.PM2_5Level, concentration_ug_m3: avgField(stations, 'PM2_5'), label: POLLUTANT_LABELS.pm2_5 },
      pm10: { level: city.PM10Level, concentration_ug_m3: avgField(stations, 'PM10'), label: POLLUTANT_LABELS.pm10 },
      o3: { level: city.O3Level, concentration_ug_m3: avgField(stations, 'O3'), label: POLLUTANT_LABELS.o3 },
      no2: { level: city.NO2Level, concentration_ug_m3: avgField(stations, 'NO2'), label: POLLUTANT_LABELS.no2 },
      so2: { level: city.SO2Level, concentration_ug_m3: avgField(stations, 'SO2'), label: POLLUTANT_LABELS.so2 },
      co: { level: city.COLevel, concentration_mg_m3: avgField(stations, 'CO'), label: POLLUTANT_LABELS.co },
    },
    pollutant_note:
      'level is CNEMC\'s 1-6 index (1=best); concentration_* is averaged across this city\'s reporting stations for the current hour. A concentration below the sensor detection limit (reported by CNEMC as "<N") is excluded from the average rather than guessed.',
    coordinates: { latitude: Number(city.Latitude) || null, longitude: Number(city.Longitude) || null },
    station_count: stations.length,
    source: 'China National Environmental Monitoring Centre (中国环境监测总站), air.cnemc.cn',
  };
}

async function airQualityRanking(args: Record<string, unknown>) {
  const direction = args.direction === 'top' ? 'top' : 'bottom';
  const n = Math.min(50, Math.max(1, Number(args.n) || 10));
  const pollutant = typeof args.pollutant === 'string' ? args.pollutant : null;
  if (pollutant && !(pollutant in POLLUTANT_LABELS)) {
    throw new Error(`user_error: unknown pollutant "${pollutant}". Valid: ${Object.keys(POLLUTANT_LABELS).join(', ')}.`);
  }

  const { rows } = await allCities();
  const levelField = pollutant ? (`${pollutant.charAt(0).toUpperCase()}${pollutant.slice(1)}Level` as keyof CityRow) : null;

  const scored = rows.map((r) => ({
    row: r,
    score: pollutant && levelField ? (Number(r[levelField]) || 0) : Number(r.AQI) || 0,
  }));

  scored.sort((a, b) => (direction === 'top' ? a.score - b.score : b.score - a.score));

  const ranked = scored.slice(0, n).map(({ row, score }, i) => ({
    rank: i + 1,
    city: cityLabel(row.Area),
    aqi: Number(row.AQI) || null,
    quality: row.Quality,
    quality_en: QUALITY_EN[row.Quality] ?? null,
    ...(pollutant ? { [`${pollutant}_level`]: score } : {}),
    primary_pollutant: row.PrimaryPollutant && row.PrimaryPollutant !== '—' ? row.PrimaryPollutant : null,
  }));

  return {
    found: true,
    direction,
    ranked_by: pollutant ? `${POLLUTANT_LABELS[pollutant]} index level` : 'AQI',
    as_of: rows[0]?.TimePoint ?? null,
    total_cities_covered: rows.length,
    returned: ranked.length,
    cities: ranked,
    source: 'China National Environmental Monitoring Centre (中国环境监测总站), air.cnemc.cn',
  };
}

async function airQualityStations(args: Record<string, unknown>) {
  const cityArg = typeof args.city === 'string' ? args.city : '';
  const zh = resolveCity(cityArg);
  if (!zh) {
    return {
      found: false,
      reason: 'city_not_recognized',
      queried: cityArg,
      hint: 'Try the English name of a major city ("Shanghai"), a province ("Zhejiang"), or the Chinese name directly ("上海市").',
    };
  }

  const stations = await stationsFor(zh);
  if (stations.length === 0) {
    return {
      found: false,
      reason: 'no_stations_reported',
      queried: cityArg,
      resolved_to: zh,
      hint: 'This city resolved but CNEMC returned no station rows for it right now — try again shortly, or use china_air_quality for the city-level summary.',
    };
  }

  return {
    found: true,
    city: cityLabel(zh),
    as_of: stations[0].TimePoint,
    station_count: stations.length,
    stations: stations.map((s) => ({
      station_name: s.PositionName,
      station_code: s.StationCode,
      aqi: Number(s.AQI) || null,
      quality: s.Quality,
      quality_en: QUALITY_EN[s.Quality] ?? null,
      primary_pollutant: s.PrimaryPollutant && s.PrimaryPollutant !== '—' ? s.PrimaryPollutant : null,
      pollutants_ug_m3: {
        pm2_5: s.PM2_5,
        pm10: s.PM10,
        o3: s.O3,
        no2: s.NO2,
        so2: s.SO2,
      },
      co_mg_m3: s.CO,
      coordinates: { latitude: Number(s.Latitude) || null, longitude: Number(s.Longitude) || null },
    })),
    source: 'China National Environmental Monitoring Centre (中国环境监测总站), air.cnemc.cn',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'china_air_quality':
      return cityAirQuality(args);
    case 'china_air_quality_ranking':
      return airQualityRanking(args);
    case 'china_air_quality_stations':
      return airQualityStations(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
