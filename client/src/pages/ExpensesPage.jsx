import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import PageHeader from '../components/common/PageHeader';
import EmptyState from '../components/common/EmptyState';
import CategoryPickerPopover from '../components/common/CategoryPickerPopover';
import CategoryEditUndoBanner from '../components/common/CategoryEditUndoBanner';
import ExclusionUndoBanner from '../components/common/ExclusionUndoBanner';
import ExpensesFilterChip from '../components/common/ExpensesFilterChip';
import { MagnifyingGlassIcon, ChevronLeftIcon, ChevronRightIcon, FolderIcon, XMarkIcon } from '../components/layout/Icons';
import { useToast } from '../contexts/ToastContext';
import { formatAbsoluteDate, formatExpenseDateFull } from '../utils/relativeDate';
import * as api from '../services/api';

// Accepts strict YYYY-MM-DD only. Lax `Date.parse` behaviour (e.g.
// "2026-4-1" without zero padding) would let malformed URLs slip
// through to the server, where the $dateFromString reject path silently
// zeroes out the row count — hurting debugging more than it helps.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(s) {
  if (typeof s !== 'string' || !ISO_DATE_RE.test(s)) return false;
  const ts = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(ts);
}

// Parse the `start`/`end` pair from the URL and return the sanitised
// values plus an explicit `rangeError` tag the page uses to fire a
// toast and scrub the offending params (see ROADMAP §2.6.1 → "Edge
// cases"). Order of checks matters:
//
//   1. Malformed string → drop that side, keep the other (user may
//      have hand-edited one param).
//   2. `start > end` → drop both (the range is logically empty and
//      we'd rather the listing load than return zero rows for a URL
//      the user didn't intend to type).
//
// Returned `start`/`end` are safe to forward to the server.
function parseRange(params) {
  const rawStart = params.get('start');
  const rawEnd = params.get('end');
  const startValid = isValidIsoDate(rawStart);
  const endValid = isValidIsoDate(rawEnd);

  if (rawStart && !startValid) {
    return { start: null, end: endValid ? rawEnd : null, rangeError: 'malformed' };
  }
  if (rawEnd && !endValid) {
    return { start: startValid ? rawStart : null, end: null, rangeError: 'malformed' };
  }
  const start = startValid ? rawStart : null;
  const end = endValid ? rawEnd : null;
  if (start && end && start > end) {
    return { start: null, end: null, rangeError: 'inverted' };
  }
  return { start, end, rangeError: null };
}

// Per-entry auto-dismiss window for the undo banner. Long enough to
// catch a "wrong row" fat-finger, short enough to not clutter the page
// if the user keeps editing — every new push re-arms its own timer,
// older entries still tick down independently.
const UNDO_WINDOW_MS = 6000;

const PER_PAGE = 20;
// Server-side cap on the bulk-move endpoint. The client mirrors it so
// we can disable "Seleccionar todas as N" up-front when the filter
// matches more than this, instead of failing with a 400 after the
// fact. docs/Categories.md §12.x — batch-move.
const BULK_MAX = 500;

export default function ExpensesPage() {
  // Renamed on destructure because `toast` is already the inline
  // success/error banner's state variable below. `toastApi` is the
  // global toast hook from the ToastContext.
  const toastApi = useToast();
  // URL is the source of truth for everything that should survive a
  // reload / bookmark / deep-link (search, page, date range). Local
  // React state only holds ephemeral UI (picker open, selection,
  // loading flag). ROADMAP §2.6.1.
  const [searchParams, setSearchParams] = useSearchParams();

  const page = Math.max(
    1,
    Number.parseInt(searchParams.get('page') ?? '1', 10) || 1,
  );
  const appliedSearch = searchParams.get('search') ?? '';
  const { start, end, rangeError } = useMemo(
    () => parseRange(searchParams),
    [searchParams],
  );
  // Deep-link from /categories → /expenses ("Ver todas →"). Mirrors the
  // server's contract on GET /api/expenses: an ObjectId narrows to that
  // category; the synthetic strings `null` / `uncategorised` both map
  // to the "Sem categoria" bucket. Anything else (malformed id) falls
  // through as no-filter — the URL gets scrubbed on the next navigation.
  const rawCategoryId = searchParams.get('category_id');
  const categoryFilter =
    rawCategoryId === 'null' || rawCategoryId === 'uncategorised'
      ? 'null'
      : /^[a-f0-9]{24}$/i.test(rawCategoryId ?? '')
        ? rawCategoryId
        : null;

  const [expenses, setExpenses] = useState([]);
  const [total, setTotal] = useState(0);
  // `search` is just the input buffer — only lands on the URL when
  // the user submits the form. Pre-fill with whatever is already on
  // the URL so a hard refresh keeps the input in sync.
  const [search, setSearch] = useState(appliedSearch);
  const [loading, setLoading] = useState(true);
  // Category catalogue for the <CategoryPickerPopover>. Loaded once on
  // mount; the list is small (§5.5 assumes ≤ 30 entries) and static
  // within a page lifetime, so there's no reason to refetch per click.
  // Failures are silent — the popover's empty-state covers them.
  const [categories, setCategories] = useState([]);
  // Companion `category_id -> icon_name` map fetched from
  // `/api/category-icons`. Forwarded to the picker so each tile
  // renders a Lucide glyph instead of the first-letter fallback.
  // Failures yield an empty map — <CategoryIcon> degrades to the
  // Tag fallback per-tile, so the popover stays usable.
  const [iconByCategory, setIconByCategory] = useState(() => new Map());
  // Which row has the single-row popover open. Single-open-at-a-time
  // by design; the popover is a focused modal-ish interaction and two
  // of them on screen would muddle the "click outside to dismiss"
  // heuristic.
  const [pickerExpenseId, setPickerExpenseId] = useState(null);
  const [pickerSaving, setPickerSaving] = useState(false);
  // ─── Multi-select / batch-move state ────────────────────────────
  // `Set<expense_id>` for row-level selection. Persists across page
  // turns and filter changes — only explicit "Limpar" wipes it.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  // Anchor id for shift-click range selection on the current page.
  // Null if the user hasn't clicked any checkbox yet, or after a
  // filter change (range selection only makes sense within a
  // consistent visible list).
  const [lastAnchorId, setLastAnchorId] = useState(null);
  // Bulk popover mounted above the table when the user clicks
  // "Mover para…" in the action bar.
  const [bulkPickerOpen, setBulkPickerOpen] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  // Inline toast. null = silent, { type: 'ok'|'error', text } otherwise.
  // After the undo-banner refactor the ok branch is only used by the
  // bulk-move summary; single-row quick-edits stage their feedback on
  // `categoryEdits` instead. Errors (single + bulk) still land here.
  const [toast, setToast] = useState(null);
  // Pending undo entries for single-row quick-edits. Each row carries
  // enough state to reverse the PUT without needing the expense table
  // to still show the old category. Oldest first; parent-managed
  // per-entry auto-dismiss via `editTimersRef`.
  const [categoryEdits, setCategoryEdits] = useState([]);
  const editTimersRef = useRef(new Map());
  // ROADMAP §2.10 — exclusion undo banner. One entry per toggle
  // (bulk OR single-row) with a 6 s dismiss window. `direction` is
  // `'excluded'` or `'included'` so Anular knows which inverse call
  // to fire. We deliberately stack per-action (not per-expense) so a
  // bulk "excluir 10" is one row the user can undo as a whole.
  const [exclusionUndo, setExclusionUndo] = useState(null);
  const exclusionUndoTimerRef = useRef(null);
  const [exclusionBusy, setExclusionBusy] = useState(false);

  // URL-writing helpers. All callers go through these so there's one
  // place to decide which params survive a transition (e.g. changing
  // the search resets `page` to 1, but changing pages preserves
  // `start/end/search`).
  const updateParams = (mutator) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        mutator(next);
        return next;
      },
      { replace: false },
    );
  };
  const setPage = (next) => {
    updateParams((p) => {
      if (next <= 1) p.delete('page');
      else p.set('page', String(next));
    });
  };
  const applySearch = (value) => {
    updateParams((p) => {
      if (value) p.set('search', value);
      else p.delete('search');
      p.delete('page');
    });
  };
  const clearDateRange = () => {
    updateParams((p) => {
      p.delete('start');
      p.delete('end');
      p.delete('page');
    });
  };
  const clearCategoryFilter = () => {
    updateParams((p) => {
      p.delete('category_id');
      p.delete('page');
    });
  };

  // Invalid-range recovery. Runs once per URL change — if parseRange
  // flagged a malformed or inverted range, surface a toast and scrub
  // the offending params via `replace` so back-button doesn't bring
  // the user back to the broken URL. The toast copy distinguishes
  // the two classes so the user knows whether they fat-fingered a
  // date or swapped start/end.
  useEffect(() => {
    if (!rangeError) return;
    const text =
      rangeError === 'inverted'
        ? 'Intervalo de datas inválido — a data final é anterior à inicial.'
        : 'Intervalo de datas em formato inválido.';
    toastApi.error(text, { id: 'expenses-range-error' });
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('start');
        next.delete('end');
        next.delete('page');
        return next;
      },
      { replace: true },
    );
    // `rangeError` is derived from searchParams — including the latter
    // would re-fire this effect on every cleanup pass. React's strict
    // mode double-invoke is covered by the toast's id-dedupe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeError]);

  const fetchExpenses = async () => {
    setLoading(true);
    try {
      const res = await api.getExpenses({
        page,
        limit: PER_PAGE,
        search: appliedSearch,
        // start/end are omitted from the URLSearchParams serialisation
        // when null/undefined — `new URLSearchParams({ start: null })`
        // would render `start=null`, which the server would then
        // happily refuse to parse. Guard here, not at the API layer.
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
        ...(categoryFilter ? { category_id: categoryFilter } : {}),
        sort: '-date',
      });
      setExpenses(res.data ?? []);
      setTotal(res.meta?.total ?? 0);
    } catch {
      /* handled by empty state */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Skip the fetch when the URL has a range-error we're about to
    // scrub — avoids a round-trip to a filter we'll reject.
    if (rangeError) return;
    fetchExpenses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, appliedSearch, start, end, categoryFilter, rangeError]);

  // Keep the search input in sync with URL changes — covers the
  // browser back/forward case where `appliedSearch` flips without the
  // user typing. `useState(initial)` only runs once on mount, so
  // without this the input would drift from the URL on navigation.
  useEffect(() => {
    setSearch(appliedSearch);
  }, [appliedSearch]);

  useEffect(() => {
    api
      .getCategories()
      .then((res) => setCategories(res.data ?? []))
      .catch(() => setCategories([]));

    // Icon mapping for the popover tiles — fetched in parallel with
    // the catalogue, silent on failure. See <CategoryPickerPopover>'s
    // iconByCategory prop doc for the shape.
    api
      .getCategoryIcons()
      .then((res) => {
        const entries = (res.data ?? []).map((row) => [
          String(row.category_id),
          row.icon_name,
        ]);
        setIconByCategory(new Map(entries));
      })
      .catch(() => setIconByCategory(new Map()));
  }, []);

  // Shift-click range support: when the user clicks a checkbox with
  // Shift held, we select every row between the anchor and the
  // clicked row inclusive (within the current visible page). If no
  // anchor exists, fall back to a single toggle.
  const toggleRow = (id, event) => {
    const rangeMode = event?.shiftKey && lastAnchorId;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (rangeMode) {
        const anchorIdx = expenses.findIndex((e) => e._id === lastAnchorId);
        const targetIdx = expenses.findIndex((e) => e._id === id);
        if (anchorIdx >= 0 && targetIdx >= 0) {
          const [lo, hi] =
            anchorIdx <= targetIdx
              ? [anchorIdx, targetIdx]
              : [targetIdx, anchorIdx];
          for (let i = lo; i <= hi; i++) next.add(expenses[i]._id);
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setLastAnchorId(id);
  };

  // Master checkbox in the thead — selects/deselects all rows on the
  // CURRENT page only. "Seleccionar todas as N" across pages is a
  // separate explicit link that appears in the action bar banner.
  const pageIds = useMemo(() => expenses.map((e) => e._id), [expenses]);
  const pageFullySelected =
    pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const pagePartiallySelected =
    !pageFullySelected && pageIds.some((id) => selectedIds.has(id));

  const toggleAllOnPage = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (pageFullySelected) {
        // Deselect the page's rows from the wider selection.
        for (const id of pageIds) next.delete(id);
      } else {
        for (const id of pageIds) next.add(id);
      }
      return next;
    });
  };

  // Gmail-style "Seleccionar todas as N que correspondem ao filtro".
  // Fires a compact id-only fetch against the same filter as the
  // current list and replaces the selection with the result. Guarded
  // by the BULK_MAX client check so we never hit the 400 on the
  // server — if total is over the cap, the action bar shows a
  // warning instead of the link.
  const selectAllMatching = async () => {
    if (total > BULK_MAX) return;
    try {
      const res = await api.getExpenseIds({
        search: appliedSearch,
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
        ...(categoryFilter ? { category_id: categoryFilter } : {}),
        sort: '-date',
      });
      setSelectedIds(new Set(res.ids ?? []));
      setLastAnchorId(null);
    } catch (err) {
      setToast({
        type: 'error',
        text: err?.message ?? 'Não foi possível seleccionar todas.',
      });
    }
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setLastAnchorId(null);
    setBulkPickerOpen(false);
  };

  // ─── Undo-banner plumbing ───────────────────────────────────────
  // Each entry has its own setTimeout stored in `editTimersRef` so
  // timers are cancellable independently (Anular cancels its own
  // timer; re-pushing the same expense re-arms it). The map is kept
  // outside React state because timer ids are not rendering data.
  const clearEditTimer = (id) => {
    const t = editTimersRef.current.get(id);
    if (t) {
      clearTimeout(t);
      editTimersRef.current.delete(id);
    }
  };
  const scheduleEditDismiss = (id) => {
    clearEditTimer(id);
    const t = setTimeout(() => {
      setCategoryEdits((prev) => prev.filter((e) => e.id !== id));
      editTimersRef.current.delete(id);
    }, UNDO_WINDOW_MS);
    editTimersRef.current.set(id, t);
  };
  // Dedupe-per-expense on push. If the user already has a pending
  // entry for the same expense (e.g. fat-fingered twice), we keep the
  // *original* prevCategory so "Anular" always lands on the truly
  // pre-edit state, but refresh the nextCategoryName + reset the
  // auto-dismiss timer against the latest click.
  const pushCategoryEdit = (entry) => {
    setCategoryEdits((prev) => {
      const existing = prev.find((e) => e.expenseId === entry.expenseId);
      if (existing) clearEditTimer(existing.id);
      const merged = existing
        ? {
            ...entry,
            prevCategoryId: existing.prevCategoryId,
            prevCategoryName: existing.prevCategoryName,
          }
        : entry;
      const rest = prev.filter((e) => e.expenseId !== entry.expenseId);
      return [...rest, merged];
    });
    scheduleEditDismiss(entry.id);
  };
  // Component-unmount cleanup — empty the timer map so React doesn't
  // get setCategoryEdits calls after tear-down.
  useEffect(() => {
    const timers = editTimersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // Quick-edit save: optimistic update first, then PUT, then rollback
  // on failure. Matches the flow described in docs/Categories.md §12.4
  // (default "inofensivo" path). `category_id` may be null to clear.
  //
  // Success path no longer fires the old "Categoria actualizada." toast
  // — the chip already changed in place so the toast was just noise.
  // We stage a reversible undo entry instead (see §12.8 rationale):
  // the banner gives the user a short grace window to catch a
  // wrong-row click before the change "commits" from their perspective.
  const handleCategorySave = async (expenseId, newCategoryId) => {
    const prev = expenses;
    // Snapshot the row's current state for the undo entry. We read
    // from the live `expenses` array instead of the popover's
    // `expense` prop so rapid double-edits still capture the correct
    // pre-click state (the prop is stale after the first optimistic
    // flip).
    const prevRow = prev.find((e) => e._id === expenseId);
    const entity = prevRow?.entity ?? '';
    const prevCategoryId = prevRow?.category_id ?? null;
    const prevCategoryName = prevRow?.category_name ?? null;
    // Optimistic: swap the chip name immediately. We don't know the
    // new category_name locally yet, so look it up from the catalogue
    // and fall back to `—` for null.
    const newCategoryName = newCategoryId
      ? categories.find((c) => String(c._id) === String(newCategoryId))?.name ?? null
      : null;
    setExpenses((rows) =>
      rows.map((e) =>
        e._id === expenseId
          ? { ...e, category_id: newCategoryId, category_name: newCategoryName }
          : e,
      ),
    );
    setPickerSaving(true);
    try {
      const res = await api.updateExpenseCategory(expenseId, newCategoryId);
      // Authoritative update from the server — mostly to keep
      // `updated_at` in sync and catch the edge case where the name
      // lookup missed (race with a category being renamed elsewhere).
      setExpenses((rows) =>
        rows.map((e) => (e._id === expenseId ? { ...e, ...res.data } : e)),
      );
      pushCategoryEdit({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        expenseId,
        entity,
        prevCategoryId,
        prevCategoryName,
        nextCategoryName: res.data?.category_name ?? newCategoryName,
      });
      setPickerExpenseId(null);
    } catch (err) {
      // Rollback to the pre-click snapshot so the chip reverts.
      setExpenses(prev);
      setToast({
        type: 'error',
        text: err?.message ?? 'Não foi possível actualizar a categoria.',
      });
    } finally {
      setPickerSaving(false);
    }
  };

  // Anular handler — optimistic revert + PUT back to prevCategoryId.
  // On success we drop the entry (the chip already shows the old
  // category). On failure we restore the row to what it showed *before*
  // the Anular click, surface an error toast, and re-arm the banner
  // so the user can try again.
  const handleUndoCategoryEdit = async (entry) => {
    clearEditTimer(entry.id);
    setCategoryEdits((prev) =>
      prev.map((e) => (e.id === entry.id ? { ...e, undoing: true } : e)),
    );
    const prevRows = expenses;
    setExpenses((rows) =>
      rows.map((e) =>
        e._id === entry.expenseId
          ? {
              ...e,
              category_id: entry.prevCategoryId,
              category_name: entry.prevCategoryName,
            }
          : e,
      ),
    );
    try {
      const res = await api.updateExpenseCategory(
        entry.expenseId,
        entry.prevCategoryId,
      );
      setExpenses((rows) =>
        rows.map((e) =>
          e._id === entry.expenseId ? { ...e, ...res.data } : e,
        ),
      );
      setCategoryEdits((prev) => prev.filter((e) => e.id !== entry.id));
    } catch (err) {
      setExpenses(prevRows);
      setCategoryEdits((prev) =>
        prev.map((e) => (e.id === entry.id ? { ...e, undoing: false } : e)),
      );
      setToast({
        type: 'error',
        text: err?.message ?? 'Não foi possível anular a alteração.',
      });
      scheduleEditDismiss(entry.id);
    }
  };

  // Batch move: optimistic update on the VISIBLE rows of the current
  // page, then PUT the entire selection (which may include ids from
  // other pages), then reconcile with the server response. Rollback
  // on failure. `categoryId` may be null to clear.
  const handleBulkMove = async (categoryId) => {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    if (ids.length > BULK_MAX) {
      setToast({
        type: 'error',
        text: `Só é possível mover ${BULK_MAX} despesas de cada vez.`,
      });
      return;
    }
    const prev = expenses;
    const newCategoryName = categoryId
      ? categories.find((c) => String(c._id) === String(categoryId))?.name ?? null
      : null;
    // Optimistic: repaint the visible rows that are in the selection.
    // Rows outside the current page still flip on the server but are
    // invisible here — a refetch after success catches them if the
    // user paginates back.
    setExpenses((rows) =>
      rows.map((e) =>
        selectedIds.has(e._id)
          ? { ...e, category_id: categoryId, category_name: newCategoryName }
          : e,
      ),
    );
    setBulkSaving(true);
    try {
      const res = await api.bulkMoveExpenses(ids, categoryId);
      const { moved, skipped, target_category_name } = res;
      const targetName = target_category_name ?? 'Sem categoria';
      const movedNoun = moved === 1 ? 'despesa movida' : 'despesas movidas';
      const text =
        skipped > 0
          ? `${moved} ${movedNoun} para ${targetName}. ${skipped} ignorada${skipped === 1 ? '' : 's'} (já estavam nessa categoria).`
          : `${moved} ${movedNoun} para ${targetName}.`;
      setToast({ type: 'ok', text });
      setBulkPickerOpen(false);
      clearSelection();
    } catch (err) {
      setExpenses(prev);
      setToast({
        type: 'error',
        text: err?.message ?? 'Não foi possível mover as despesas.',
      });
    } finally {
      setBulkSaving(false);
    }
  };

  // Auto-dismiss ok toasts; keep errors visible until the user acts.
  useEffect(() => {
    if (toast?.type !== 'ok') return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // ROADMAP §2.10 — exclusion toggle. Decides whether the current
  // selection is "all excluded → re-include" or "has at least one
  // included → exclude all". Matches the spec (the button label
  // flips the same way).
  const selectionAllExcluded =
    selectedIds.size > 0
    && [...selectedIds].every((id) => {
      const row = expenses.find((e) => e._id === id);
      // Rows outside the current page can't be introspected from the
      // client — assume they're not excluded and let the server
      // reconcile. The action bar's label is based on visible state,
      // which matches the user's mental model.
      return row?.excluded === true;
    });

  const clearExclusionTimer = () => {
    if (exclusionUndoTimerRef.current) {
      clearTimeout(exclusionUndoTimerRef.current);
      exclusionUndoTimerRef.current = null;
    }
  };
  const scheduleExclusionDismiss = () => {
    clearExclusionTimer();
    exclusionUndoTimerRef.current = setTimeout(() => {
      setExclusionUndo(null);
      exclusionUndoTimerRef.current = null;
    }, UNDO_WINDOW_MS);
  };

  const handleExclusionToggle = async () => {
    if (selectedIds.size === 0 || exclusionBusy) return;
    const ids = [...selectedIds];
    const direction = selectionAllExcluded ? 'included' : 'excluded';
    const prev = expenses;
    // Optimistic: flip the flag on visible rows that are in the
    // selection. Rows outside the current page still flip on the
    // server; a refetch after success picks them up if the user
    // paginates back.
    const nextExcluded = direction === 'excluded';
    setExpenses((rows) =>
      rows.map((e) =>
        selectedIds.has(e._id) ? { ...e, excluded: nextExcluded } : e,
      ),
    );
    setExclusionBusy(true);
    try {
      const call =
        direction === 'excluded' ? api.excludeExpenses : api.includeExpenses;
      const res = await call(ids);
      const { affected, skipped } = res;
      const verbPast =
        direction === 'excluded' ? 'excluída' : 'reincluída';
      const plural = affected === 1 ? '' : 's';
      const text =
        skipped > 0
          ? `${affected} despesa${plural} ${verbPast}${plural}. ${skipped} ignorada${skipped === 1 ? '' : 's'} (já estava${skipped === 1 ? '' : 'm'} nesse estado).`
          : `${affected} despesa${plural} ${verbPast}${plural}.`;
      // Stash an undo entry instead of raising a toast — the spec
      // wants a 6 s grace window, which mirrors the category-edit
      // undo flow.
      setExclusionUndo({ ids, direction, affected, skipped, text });
      scheduleExclusionDismiss();
      clearSelection();
    } catch (err) {
      setExpenses(prev);
      setToast({
        type: 'error',
        text: err?.message ?? 'Não foi possível actualizar a exclusão.',
      });
    } finally {
      setExclusionBusy(false);
    }
  };

  const handleExclusionUndo = async () => {
    if (!exclusionUndo || exclusionBusy) return;
    clearExclusionTimer();
    const { ids, direction } = exclusionUndo;
    const prev = expenses;
    // Flip everything back on the visible rows.
    const revertedExcluded = direction === 'included';
    setExpenses((rows) =>
      rows.map((e) =>
        ids.includes(e._id) ? { ...e, excluded: revertedExcluded } : e,
      ),
    );
    setExclusionBusy(true);
    try {
      const call =
        direction === 'excluded' ? api.includeExpenses : api.excludeExpenses;
      await call(ids);
      setExclusionUndo(null);
    } catch (err) {
      setExpenses(prev);
      setToast({
        type: 'error',
        text: err?.message ?? 'Não foi possível anular.',
      });
      scheduleExclusionDismiss();
    } finally {
      setExclusionBusy(false);
    }
  };

  // Unmount cleanup for the exclusion undo timer.
  useEffect(() => {
    return () => clearExclusionTimer();
  }, []);

  // ROADMAP §2.10.1 — symmetric single-expense cycle toggle from the
  // popover header. Dispatches between `excludeExpenses` and
  // `includeExpenses` based on the row's current `excluded` flag and
  // pushes into the same `exclusionUndo` slot the bulk toggle uses.
  // Closes the popover immediately so the user sees the row tint flip
  // + banner without an extra click.
  const handleToggleSingleCycle = async (exp) => {
    if (!exp?._id || exclusionBusy) return;
    const currentlyExcluded = exp.excluded === true;
    const direction = currentlyExcluded ? 'included' : 'excluded';
    const nextExcluded = !currentlyExcluded;
    const ids = [exp._id];
    const prev = expenses;
    setExpenses((rows) =>
      rows.map((e) =>
        e._id === exp._id ? { ...e, excluded: nextExcluded } : e,
      ),
    );
    setPickerExpenseId(null);
    setExclusionBusy(true);
    try {
      const call = currentlyExcluded
        ? api.includeExpenses
        : api.excludeExpenses;
      const res = await call(ids);
      const affected = res?.affected ?? 1;
      const skipped = res?.skipped ?? 0;
      const verbPast = currentlyExcluded ? 'reincluída' : 'excluída';
      const text = `Despesa ${exp.entity} ${verbPast} ${currentlyExcluded ? 'no' : 'do'} ciclo.`;
      setExclusionUndo({
        ids,
        direction,
        affected,
        skipped,
        text,
      });
      scheduleExclusionDismiss();
    } catch (err) {
      setExpenses(prev);
      setToast({
        type: 'error',
        text:
          err?.message ??
          (currentlyExcluded
            ? 'Não foi possível reincluir no ciclo.'
            : 'Não foi possível excluir do ciclo.'),
      });
    } finally {
      setExclusionBusy(false);
    }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    applySearch(search);
  };

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  const selectionHasRowsBeyondPage =
    selectedIds.size > 0 && selectedIds.size > pageIds.filter((id) => selectedIds.has(id)).length;
  // Hint banner trigger: the user just marked the whole visible page
  // and there are more matching rows off-screen. Hidden once the
  // selection already spans beyond this page (presumably they already
  // clicked the expand link, or built a manual cross-page selection).
  const showSelectAllHint =
    pageFullySelected && total > pageIds.length && !selectionHasRowsBeyondPage;

  return (
    <>
      <PageHeader title="Despesas" description="Todas as despesas importadas" />

      {/* Inline toast — bulk-move success summary and errors from
          either the single-row quick-edit popover or the bulk move.
          Single-row successes now render as an undo banner below
          instead of a toast; the chip already changed in place, so a
          "saved" toast was just noise — what users actually want is a
          short grace window to reverse a wrong-row click. */}
      {toast && (
        <div
          className={`mb-4 animate-slide-in-right rounded-2xl px-4 py-3 text-sm ${
            toast.type === 'ok'
              ? 'bg-emerald-50 text-emerald-800'
              : 'bg-red-50 text-curve-700'
          }`}
          role={toast.type === 'error' ? 'alert' : 'status'}
        >
          {toast.text}
        </div>
      )}

      {/* Staging banner(s) for single-row quick-edits. Each entry has
          its own ~6 s auto-dismiss timer and an Anular action that
          PUTs the previous category back. Stacks top-to-bottom when
          the user edits multiple rows in quick succession; dedupe-
          per-expense keeps a single banner per row even after
          fat-fingered re-edits. */}
      <CategoryEditUndoBanner
        edits={categoryEdits}
        onUndo={handleUndoCategoryEdit}
      />

      {/* ROADMAP §2.10 — exclusion undo banner. One-at-a-time (not
          per-row like the category edits) because a bulk "excluir 10"
          is semantically one action the user will want to undo as a
          whole. 6 s window, same as the category undo. §2.10.1 also
          feeds this banner from the single-expense "Remover do ciclo"
          button inside the popover header. */}
      <ExclusionUndoBanner
        entry={exclusionUndo}
        onUndo={handleExclusionUndo}
        busy={exclusionBusy}
      />

      {/* ROADMAP §2.6.1 — active date-range chip. Feeds on the URL
          params, not internal state, so a refresh / bookmark / deep-
          link from the dashboard chart all hydrate the same view. */}
      <ExpensesFilterChip
        start={start}
        end={end}
        count={total}
        onClear={clearDateRange}
      />

      {/* Active category-filter chip. Hydrates from the `category_id`
          URL param so the deep-link from /categories → /expenses
          "Ver todas →" renders as a visible, dismissable filter rather
          than a silent server-side narrowing. Matches the date chip's
          look + clear affordance for consistency. */}
      {categoryFilter && (
        <div
          role="status"
          aria-live="polite"
          className="mb-4 flex animate-slide-in-right items-center gap-3 rounded-2xl border border-sand-200 bg-sand-50 px-4 py-2.5 text-sm text-sand-700"
        >
          <FolderIcon className="h-4 w-4 shrink-0 text-sand-500" />
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium text-sand-900">
              {categoryFilter === 'null'
                ? 'Sem categoria'
                : categories.find(
                    (c) => String(c._id) === String(categoryFilter),
                  )?.name ?? 'Categoria'}
            </span>
            <span className="ml-2 text-xs text-sand-500">
              · {total.toLocaleString('pt-PT')}{' '}
              {total === 1 ? 'despesa' : 'despesas'}
            </span>
          </span>
          <button
            type="button"
            onClick={clearCategoryFilter}
            aria-label="Limpar filtro de categoria"
            title="Limpar filtro de categoria"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sand-500 transition-colors hover:bg-sand-200 hover:text-sand-700 focus:outline-none focus:ring-2 focus:ring-curve-500/30"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Search bar */}
      <form onSubmit={handleSearch} className="mb-6 flex gap-3">
        <div className="relative flex-1">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sand-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Pesquisar por entidade, cartão…"
            className="input pl-10"
          />
        </div>
        <button type="submit" className="btn-secondary">
          Pesquisar
        </button>
      </form>

      {/* Multi-select action bar — only mounted when there's a
          selection. Gmail-style: count + clear + "Mover para…" primary
          action, with an optional hint row underneath offering to
          expand the current-page selection into "all N matching the
          filter". The hint collapses once the selection already spans
          beyond this page. */}
      {selectedIds.size > 0 && (
        <div className="mb-4 animate-slide-in-right rounded-2xl border border-curve-200 bg-curve-50 px-4 py-3 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium text-curve-800">
              {selectedIds.size}{' '}
              {selectedIds.size === 1 ? 'despesa seleccionada' : 'despesas seleccionadas'}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={clearSelection}
                disabled={bulkSaving}
                className="rounded-lg px-3 py-1.5 text-sm text-sand-600 transition-colors hover:bg-white disabled:opacity-50"
              >
                Limpar
              </button>
              {/* ROADMAP §2.10 — cycle exclusion toggle. Label flips
                  based on whether every *visible* selected row is
                  already excluded. Rows outside the current page
                  don't influence the label (we can't introspect them
                  client-side), but the server handles both forward
                  and backward toggles idempotently via `skipped`. */}
              <button
                type="button"
                onClick={handleExclusionToggle}
                disabled={bulkSaving || exclusionBusy}
                className="rounded-lg border border-curve-300 bg-white px-3 py-1.5 text-sm text-curve-800 transition-colors hover:bg-curve-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {selectionAllExcluded ? 'Incluir no ciclo' : 'Excluir do ciclo'}
              </button>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setBulkPickerOpen((v) => !v)}
                  disabled={bulkSaving}
                  className="btn-primary px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Mover para…
                </button>
                {bulkPickerOpen && (
                  <CategoryPickerPopover
                    context={{ kind: 'bulk', count: selectedIds.size }}
                    categories={categories}
                    iconByCategory={iconByCategory}
                    saving={bulkSaving}
                    onSelect={(newId) => handleBulkMove(newId)}
                    onCancel={() => {
                      if (bulkSaving) return;
                      setBulkPickerOpen(false);
                    }}
                  />
                )}
              </div>
            </div>
          </div>
          {showSelectAllHint && (
            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-curve-100 pt-2 text-xs text-sand-600">
              <span>
                Todas as {pageIds.length} desta página estão seleccionadas.
              </span>
              {total <= BULK_MAX ? (
                <button
                  type="button"
                  onClick={selectAllMatching}
                  className="font-medium text-curve-700 underline-offset-2 hover:underline"
                >
                  Seleccionar todas as {total} que correspondem ao filtro
                </button>
              ) : (
                <span className="text-curve-700">
                  Só é possível mover {BULK_MAX} de cada vez — {total}{' '}
                  correspondem ao filtro. Refina a pesquisa.
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-curve-300 border-t-curve-700" />
        </div>
      ) : expenses.length === 0 ? (
        // Contextual empty state — when a date range is active, the
        // generic "ajusta a pesquisa" copy misleads (the user's query
        // string may be empty, the filter is what produced zero rows).
        // Offer a direct way back to the unfiltered list without
        // forcing them to hunt for the chip's × button.
        start || end ? (
          <div className="rounded-2xl border border-sand-200 bg-white p-10 text-center">
            <p className="text-base font-medium text-sand-900">
              Sem despesas{' '}
              {start && end
                ? `entre ${formatAbsoluteDate(start)} e ${formatAbsoluteDate(end)}`
                : start
                  ? `a partir de ${formatAbsoluteDate(start)}`
                  : `até ${formatAbsoluteDate(end)}`}
            </p>
            <p className="mt-1 text-sm text-sand-500">
              {appliedSearch
                ? 'Experimenta alargar a janela ou limpar a pesquisa.'
                : 'Experimenta alargar a janela.'}
            </p>
            <Link
              to="/expenses"
              onClick={() => setSearch('')}
              className="mt-5 inline-flex items-center rounded-full bg-curve-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-curve-700 focus:outline-none focus:ring-2 focus:ring-curve-500/30"
            >
              Ver todas as despesas
            </Link>
          </div>
        ) : (
          <EmptyState title="Sem resultados" description="Tenta ajustar a pesquisa." />
        )
      ) : (
        <div
          /* `overflow-hidden` clips the CategoryPickerPopover that
             escapes the last column. Toggle it off while either the
             single-row or the bulk picker is open so the popover can
             render over the row below. */
          className={`animate-fade-in rounded-2xl border border-sand-200 bg-white ${
            pickerExpenseId || bulkPickerOpen ? '' : 'overflow-hidden'
          }`}
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-sand-100 text-left text-xs font-medium uppercase tracking-wide text-sand-400">
                <th className="w-10 px-5 py-3">
                  <input
                    type="checkbox"
                    aria-label={
                      pageFullySelected
                        ? 'Limpar selecção desta página'
                        : 'Seleccionar todas desta página'
                    }
                    checked={pageFullySelected}
                    ref={(el) => {
                      if (el) el.indeterminate = pagePartiallySelected;
                    }}
                    onChange={toggleAllOnPage}
                    className="h-4 w-4 cursor-pointer rounded border-sand-300 text-curve-600 focus:ring-curve-500"
                  />
                </th>
                <th className="px-5 py-3">Entidade</th>
                <th className="px-5 py-3">Montante</th>
                <th className="px-5 py-3">Data</th>
                <th className="px-5 py-3">Cartão</th>
                <th className="px-5 py-3">Categoria</th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((exp, i) => {
                const pickerOpen = pickerExpenseId === exp._id;
                const rowSelected = selectedIds.has(exp._id);
                const rowExcluded = exp.excluded === true;
                // When there's an active selection, disable the
                // single-row quick-edit so the two flows don't compete
                // for the same `category_id`. The chip is still
                // visible, just no longer clickable.
                const chipDisabled = selectedIds.size > 0;
                // Row tinting priority: selection > excluded > hover.
                // Selection stays on top because it communicates the
                // user's current intent, not a persistent attribute
                // of the row. Excluded rows use a sand background +
                // per-cell dimming — `opacity` on the <tr> itself
                // would create a stacking context and trap the
                // CategoryPickerPopover behind the rows below it,
                // capturing clicks on the table instead of the toggle
                // button (bug from §2.10.1 first pass). The category
                // cell deliberately skips the dim so the chip + the
                // popover it anchors stay fully clickable.
                const rowClass = rowSelected
                  ? 'bg-curve-50'
                  : rowExcluded
                    ? 'bg-sand-50 hover:bg-sand-100'
                    : 'hover:bg-sand-50';
                const dimCell = rowExcluded ? 'opacity-60' : '';
                return (
                  <tr
                    key={exp._id ?? i}
                    title={
                      rowExcluded
                        ? 'Esta despesa está excluída do cálculo do ciclo e do Savings Score'
                        : undefined
                    }
                    className={`border-b border-sand-50 transition-colors duration-150 ${rowClass}`}
                  >
                    <td className={`px-5 py-3 ${dimCell}`}>
                      <input
                        type="checkbox"
                        aria-label={`Seleccionar ${exp.entity}`}
                        checked={rowSelected}
                        onChange={(e) => toggleRow(exp._id, e.nativeEvent)}
                        onClick={(e) => {
                          // React's onChange doesn't carry shiftKey
                          // reliably across browsers; the native
                          // `click` event does. We stash the modifier
                          // on the synthetic event's nativeEvent and
                          // read it in `toggleRow`.
                          e.nativeEvent.shiftKey = e.shiftKey;
                        }}
                        className="h-4 w-4 cursor-pointer rounded border-sand-300 text-curve-600 focus:ring-curve-500"
                      />
                    </td>
                    <td className={`px-5 py-3 font-medium text-sand-900 ${dimCell}`}>
                      {exp.entity}
                    </td>
                    <td className={`px-5 py-3 font-semibold text-curve-700 ${dimCell}`}>
                      €{Number(exp.amount).toFixed(2)}
                    </td>
                    <td className={`px-5 py-3 text-sand-500 ${dimCell}`}>
                      <div className="flex items-center gap-2">
                        <span>{formatExpenseDateFull(exp.date)}</span>
                        {rowExcluded && (
                          <span className="badge bg-sand-200 text-sand-600">
                            excluída
                          </span>
                        )}
                      </div>
                    </td>
                    <td className={`px-5 py-3 text-sand-500 ${dimCell}`}>{exp.card}</td>
                    <td className="relative px-5 py-3">
                      <button
                        type="button"
                        onClick={() => !chipDisabled && setPickerExpenseId(exp._id)}
                        disabled={chipDisabled}
                        className={`rounded-lg text-left transition-colors focus:outline-none focus:ring-2 focus:ring-curve-500/30 ${
                          chipDisabled
                            ? 'cursor-default opacity-60'
                            : 'hover:bg-sand-100'
                        }`}
                        aria-label={`Alterar categoria de ${exp.entity}`}
                      >
                        {exp.category_name ? (
                          <span className="badge bg-sand-100 text-sand-600">
                            {exp.category_name}
                          </span>
                        ) : (
                          <span className="px-2 text-sand-300">—</span>
                        )}
                      </button>
                      {pickerOpen && (
                        <CategoryPickerPopover
                          expense={exp}
                          categories={categories}
                          iconByCategory={iconByCategory}
                          saving={pickerSaving}
                          excluded={exp.excluded === true}
                          onSelect={(newId) =>
                            handleCategorySave(exp._id, newId)
                          }
                          onToggleCycle={() => handleToggleSingleCycle(exp)}
                          onCancel={() => {
                            if (pickerSaving) return;
                            setPickerExpenseId(null);
                          }}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Pagination */}
          <div className="flex items-center justify-between border-t border-sand-100 px-5 py-3">
            <span className="text-xs text-sand-400">
              {total} despesa{total !== 1 ? 's' : ''}
            </span>
            <div className="flex items-center gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
                className="rounded-lg p-1.5 text-sand-400 transition-colors hover:bg-sand-100 disabled:opacity-30"
              >
                <ChevronLeftIcon className="h-4 w-4" />
              </button>
              <span className="text-xs text-sand-500">
                {page} / {totalPages}
              </span>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
                className="rounded-lg p-1.5 text-sand-400 transition-colors hover:bg-sand-100 disabled:opacity-30"
              >
                <ChevronRightIcon className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
