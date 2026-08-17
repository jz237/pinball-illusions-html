/**
 * GLOBAL SCORES: the shared site-wide worker, joined the way the siblings did.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT (probed live 2026-08-16, and stated in the Fantasies adapter)
 * ---------------------------------------------------------------------------
 * Base endpoint: `https://game-scores.jez237.workers.dev/scores/<key>`.
 * GET returns a bare JSON array of `{initials, score, ts}` rows; an empty —
 * or merely nonexistent — board is `200 []`. POST takes JSON
 * `{initials, score}` with `Content-Type: application/json`; the response
 * body is undocumented and only `response.ok` may be consulted. CORS is
 * wildcard and the live page's CSP already allowlists the host.
 *
 * The worker's measured quirks, each designed around here rather than hoped
 * away:
 *
 *  - `?limit=` is IGNORED (a 39-row board came back for `?limit=2`), so the
 *    normalizer sorts and slices client-side, always.
 *  - Extra POST fields do NOT round-trip — the worker persists only
 *    `{initials, score, ts}` — so nothing here sends or renders metadata.
 *  - ANY key returns `200 []`: a typo'd key silently splits the board
 *    forever, which is why the three production keys are minted in ONE place
 *    (`globalScoreKey` over the shell's own table ids) and pinned verbatim by
 *    a test.
 *  - No auth, no dedupe, no delete, and live sibling boards carry bot rows —
 *    so rendering is defensive: non-finite, zero, negative and
 *    impossible-for-this-machine scores are dropped and the rest re-sorted.
 *  - Responses carry no Cache-Control, so every request is `no-store`.
 *
 * ---------------------------------------------------------------------------
 * THE DOCTRINE, which is every sibling's doctrine
 * ---------------------------------------------------------------------------
 * The machine-decoded local ladder (`src/game/high-scores.ts`) remains the
 * source of truth for everything in the game: the fanfare, the initials walk,
 * the attract board. The global board is decoration on the front door. Every
 * request here is abortable, offline-tolerant, and must never affect
 * gameplay: a failed fetch renders as nothing, a failed submit is dropped
 * without retry, and nothing in this file throws past its own boundary.
 */

import { MAX_BCD_SCORE } from "../game/high-scores.js";
import { TABLE_IDS } from "../game/contracts.js";
import type { TableId } from "../game/contracts.js";

export const GLOBAL_SCORES_BASE_URL = "https://game-scores.jez237.workers.dev/scores";

/**
 * The board keys: `pinball-illusions-<table id>`, verbatim the shell's own
 * table ids — the Fantasies convention (`pinball-fantasies-<table id>`,
 * a deliberate invariant per its shell), on the same worker's one flat
 * namespace. Minted here and nowhere else: the worker accepts any string and
 * answers `200 []`, so a typo would not fail — it would quietly start a
 * second, invisible board. `tests/global-scores.test.ts` pins all three
 * strings. If a wire mistake ever forces a change, bump a `-v2` suffix;
 * never reuse a key.
 */
export const GLOBAL_SCORE_KEY_PREFIX = "pinball-illusions-";

export function globalScoreKey(tableId: TableId): string {
  return `${GLOBAL_SCORE_KEY_PREFIX}${tableId}`;
}

/** How many rows the door could ever show. The slice is client-side law. */
export const GLOBAL_TOP_LIMIT = 10;

/** The Fantasies adapter's timeout, kept: a dead worker costs one board, not a hang. */
export const GLOBAL_TIMEOUT_MS = 7000;

export interface GlobalScoreRow {
  readonly initials: string;
  readonly score: number;
}

/** Where one table's board stands, for the door's line. */
export type GlobalBoardStatus = "idle" | "loading" | "ready" | "offline";

// -- the injectable fetch, structural so a test drives a plain function -----

export interface GlobalScoresResponseLike {
  readonly ok: boolean;
  json(): Promise<unknown>;
}

export interface GlobalScoresRequestInit {
  readonly method: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly cache?: "no-store";
  readonly signal?: AbortSignal;
}

export type GlobalScoresFetch = (
  url: string,
  init: GlobalScoresRequestInit,
) => Promise<GlobalScoresResponseLike>;

export interface GlobalScoresOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

/** Uppercase A-Z0-9 only, at most three characters — the sibling boards' alphabet. */
export function normalizeGlobalInitials(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 3);
}

function rowInitials(row: Record<string, unknown>): string {
  const value = row["initials"];
  if (typeof value === "string" || typeof value === "number") {
    const cleaned = normalizeGlobalInitials(String(value));
    if (cleaned.length > 0) return cleaned;
  }
  return "---";
}

/**
 * Defensively normalize a worker payload into at most `GLOBAL_TOP_LIMIT`
 * descending rows.
 *
 * Drops everything a healthy board cannot contain — non-objects, non-finite
 * and non-positive scores, and scores past `MAX_BCD_SCORE`, which no game of
 * this machine can produce (the score file is seven packed-BCD bytes;
 * anything larger is a bot's row, and live sibling boards do carry those).
 * Sorts and slices itself because the worker ignores `?limit=` and its sort
 * order is nowhere guaranteed.
 */
export function normalizeGlobalRows(payload: unknown): readonly GlobalScoreRow[] {
  const rows: readonly unknown[] = Array.isArray(payload) ? payload : [];
  const entries: GlobalScoreRow[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const score = Number(record["score"]);
    if (!Number.isFinite(score) || score <= 0 || score > MAX_BCD_SCORE) continue;
    entries.push({ initials: rowInitials(record), score });
  }
  entries.sort((left, right) => right.score - left.score);
  return Object.freeze(entries.slice(0, GLOBAL_TOP_LIMIT));
}

/**
 * The door's one line about a board, in the Fantasies select-screen manner:
 * the champion when there is one, an invitation when the board is truly
 * empty, and NOTHING — never an error — while unknown or offline.
 */
export function globalChampionLine(
  status: GlobalBoardStatus,
  rows: readonly GlobalScoreRow[],
): string {
  const top = rows[0];
  if (top !== undefined) {
    return `Global ★ ${top.initials} · ${top.score.toLocaleString("en-US")}`;
  }
  return status === "ready" ? "No global score yet" : "";
}

export interface GlobalScores {
  /**
   * One qualifying player's row, fire-and-forget. Resolves false — never
   * rejects — on any failure; nothing downstream may depend on it.
   */
  submit(tableId: TableId, initials: string, score: number): Promise<boolean>;
  /** The board, cached after the first success; `force` refetches. */
  fetchTop(tableId: TableId, force?: boolean): Promise<readonly GlobalScoreRow[]>;
  /** The door's synchronous read of whatever the cache holds right now. */
  topLine(tableId: TableId): string;
  status(tableId: TableId): GlobalBoardStatus;
}

interface BoardState {
  status: GlobalBoardStatus;
  cached: readonly GlobalScoreRow[] | null;
  inflight: Promise<readonly GlobalScoreRow[]> | null;
}

const NO_ROWS: readonly GlobalScoreRow[] = Object.freeze([]);

function defaultFetch(): GlobalScoresFetch | null {
  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch !== "function") return null;
  return (url, init) => nativeFetch.call(globalThis, url, init);
}

/**
 * The client. Injected into `main.ts` the way `ScoreStore` is, with the fetch
 * injectable under it, so the whole flow runs in a test against a plain fake
 * and the production URL is never touched by the suite.
 */
export function createGlobalScores(
  fetchImpl?: GlobalScoresFetch,
  options: GlobalScoresOptions = {},
): GlobalScores {
  const request = fetchImpl ?? defaultFetch();
  const baseUrl = options.baseUrl ?? GLOBAL_SCORES_BASE_URL;
  const timeoutMs = options.timeoutMs ?? GLOBAL_TIMEOUT_MS;

  const boards = new Map<TableId, BoardState>();
  for (const tableId of TABLE_IDS) {
    boards.set(tableId, { status: "idle", cached: null, inflight: null });
  }
  const boardOf = (tableId: TableId): BoardState => {
    const held = boards.get(tableId);
    if (held !== undefined) return held;
    const made: BoardState = { status: "idle", cached: null, inflight: null };
    boards.set(tableId, made);
    return made;
  };

  const urlOf = (tableId: TableId): string =>
    `${baseUrl}/${encodeURIComponent(globalScoreKey(tableId))}`;

  async function abortableRequest(
    url: string,
    init: GlobalScoresRequestInit,
  ): Promise<GlobalScoresResponseLike> {
    if (request === null) throw new Error("global scores fetch is unavailable");
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer =
      controller === null
        ? null
        : setTimeout(() => {
            controller.abort();
          }, timeoutMs);
    try {
      return await request(url, {
        ...init,
        ...(controller === null ? {} : { signal: controller.signal }),
      });
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  async function fetchTop(
    tableId: TableId,
    force = false,
  ): Promise<readonly GlobalScoreRow[]> {
    const board = boardOf(tableId);
    if (!force && board.cached !== null) return board.cached;
    if (board.inflight !== null) return board.inflight;
    board.status = "loading";
    board.inflight = (async () => {
      try {
        const response = await abortableRequest(urlOf(tableId), {
          method: "GET",
          cache: "no-store",
        });
        if (!response.ok) throw new Error("global scores fetch was rejected");
        board.cached = normalizeGlobalRows(await response.json());
        board.status = "ready";
        return board.cached;
      } catch {
        board.status = "offline";
        return board.cached ?? NO_ROWS;
      } finally {
        board.inflight = null;
      }
    })();
    return board.inflight;
  }

  async function submit(
    tableId: TableId,
    rawInitials: string,
    rawScore: number,
  ): Promise<boolean> {
    const initials = normalizeGlobalInitials(rawInitials);
    const score = Math.round(rawScore);
    // The same gate the board render applies: a row the normalizer would
    // drop on the way back is not worth sending on the way out.
    if (initials.length === 0 || !Number.isFinite(score) || score <= 0 || score > MAX_BCD_SCORE) {
      return false;
    }
    try {
      const response = await abortableRequest(urlOf(tableId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // {initials, score} and NOTHING else: the worker drops extra fields
        // silently, so sending them is a promise the readback cannot keep.
        body: JSON.stringify({ initials, score }),
      });
      if (!response.ok) {
        boardOf(tableId).status = "offline";
        return false;
      }
      // The next door visit refetches, so the fresh row appears.
      boardOf(tableId).cached = null;
      return true;
    } catch {
      boardOf(tableId).status = "offline";
      return false;
    }
  }

  return Object.freeze({
    submit,
    fetchTop,
    topLine: (tableId: TableId): string => {
      const board = boardOf(tableId);
      return globalChampionLine(board.status, board.cached ?? NO_ROWS);
    },
    status: (tableId: TableId): GlobalBoardStatus => boardOf(tableId).status,
  });
}
