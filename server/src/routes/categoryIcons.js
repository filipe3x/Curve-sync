import { Router } from 'express';
import mongoose from 'mongoose';
import Category from '../models/Category.js';
import CategoryIcon from '../models/CategoryIcon.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { isAllowedIconName } from '../services/iconRegistry.js';
import { audit, clientIp } from '../services/audit.js';

const router = Router();

// ─────────────────────────────────────────────────────────────────────
// GET /api/category-icons
//
// Returns the full `category_id → icon_name` mapping as a flat array.
// All authenticated users get the same response — icons are
// catalogue-level, not per-user, so there is no scoping by
// `req.userId` here (unlike /api/category-overrides).
//
// Response shape:
//   { data: [{ category_id, icon_name }, ...] }
//
// The frontend keeps this in a single Map keyed by `category_id` and
// feeds it to every renderer that shows a category chip:
//   - CategoryPickerPopover (quick-edit on /expenses + dashboard)
//   - CreateCategoryDialog (admin creation flow)
//   - CategoriesPage (list rows + detail header + distribution bar)
//   - ExpensesPage + DashboardPage (category chip in expense rows)
//
// At MVP scale (~50 categories) the whole mapping is sub-kB, so we
// don't bother paginating or allowing a partial fetch. A cache layer
// lives on the client (single fetch on page mount, no polling).
// ─────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const rows = await CategoryIcon.find()
      .select('category_id icon_name')
      .lean();
    res.json({
      data: rows.map((r) => ({
        category_id: r.category_id.toString(),
        icon_name: r.icon_name,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// PUT /api/category-icons/:category_id   (admin only)
//
// Set or change the icon associated with a category. Upsert semantics:
// creates the row if the category has no icon yet, updates the
// existing row otherwise. Returns the final document so the client
// can drop the response straight into the icon Map without a refetch.
//
// Auth: `authenticate` (router-level) + `requireAdmin` (per-route).
// Non-admins get 403 + `admin_access_failed` audit row via the
// middleware.
//
// Route params:
//   :category_id — must be a valid ObjectId pointing at an existing
//                  `categories` row (404 `category_not_found` otherwise).
//                  We look up the target to both validate and capture
//                  the category name for the audit detail.
//
// Body:
//   { icon_name: string }  — must be in the `iconRegistry` whitelist.
//
// Validation:
//   404 category_not_found   — invalid id or no such category
//   400 invalid_icon_name    — name missing, not a string, or not in
//                              the whitelist (docs/Categories.md
//                              decision: the client ships a fixed
//                              picker, so we only accept names it
//                              knows how to render)
//
// Response: 200 { data: { category_id, icon_name } }
//
// Audit (new action `category_icon_updated`):
//   detail: `category=<name> icon=<new> previous=<old|none>`
//
// The "previous=<old|none>" suffix gives the audit trail a readable
// diff without needing a second query at rendering time — same
// pattern category_updated and expense_category_changed use.
// Skipping the audit row when new === previous (no-op PUT) matches
// §13.4: autosave-style writes that don't change state don't dirty
// the log.
// ─────────────────────────────────────────────────────────────────────
router.put('/:category_id', requireAdmin, async (req, res) => {
  try {
    const { category_id } = req.params;
    if (!mongoose.isValidObjectId(category_id)) {
      return res.status(404).json({ error: 'category_not_found' });
    }

    const category = await Category.findById(category_id)
      .select('_id name')
      .lean();
    if (!category) {
      return res.status(404).json({ error: 'category_not_found' });
    }

    const { icon_name } = req.body ?? {};
    if (!isAllowedIconName(icon_name)) {
      return res.status(400).json({ error: 'invalid_icon_name' });
    }

    // Load the existing row (if any) so the audit detail can carry
    // `previous=<old>` and so we can skip the write/log when the name
    // is unchanged. One extra round trip in exchange for a clean
    // no-op path — still cheaper than a findOneAndUpdate + a second
    // read for the audit detail.
    const existing = await CategoryIcon.findOne({ category_id }).lean();
    if (existing && existing.icon_name === icon_name) {
      // No-op: same icon already persisted. Return the current doc
      // so clients that PUT idempotently (e.g. an autosave path)
      // still see a coherent response, but skip the audit row.
      return res.json({
        data: {
          category_id: existing.category_id.toString(),
          icon_name: existing.icon_name,
        },
      });
    }

    // Upsert. `new: true` returns the document AFTER the write so the
    // response reflects the persisted state exactly.
    const doc = await CategoryIcon.findOneAndUpdate(
      { category_id },
      { $set: { icon_name } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    audit({
      action: 'category_icon_updated',
      userId: req.userId,
      ip: clientIp(req),
      detail:
        `category=${category.name} icon=${icon_name} ` +
        `previous=${existing?.icon_name ?? 'none'}`,
    });

    res.json({
      data: {
        category_id: doc.category_id.toString(),
        icon_name: doc.icon_name,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// DELETE /api/category-icons/:category_id   (admin only)
//
// Clear the icon associated with a category. Idempotent — deleting
// an already-absent icon returns 204 without writing an audit row,
// matching the §13.4 "no state change, no log" contract.
//
// Auth: `authenticate` + `requireAdmin`.
//
// Route params:
//   :category_id — validated as ObjectId. 404 `category_not_found`
//                  for invalid ids; the category itself is allowed
//                  to be missing (admin might be clearing an icon
//                  belonging to a category that was just deleted
//                  in a parallel tab — the DELETE still succeeds).
//
// Responses:
//   204 on success (no body) — whether an icon actually existed or
//       not, so the UI doesn't need a pre-flight check.
//   404 category_not_found   — id is not a valid ObjectId.
//
// Audit (new action `category_icon_updated` with `icon=none`):
//   detail: `category=<name> icon=none previous=<old>`
//
// We reuse the same action as the PUT path with a sentinel
// `icon=none` because the two operations are "admin changed the
// icon" from the user's viewpoint. The curveLogsUtils renderer
// translates both into "Ícone de <category> alterado" and suffixes
// `→ nenhum` on the clear variant. Keeping one enum value also
// avoids a 13th case in the CurveLog action enum.
// ─────────────────────────────────────────────────────────────────────
router.delete('/:category_id', requireAdmin, async (req, res) => {
  try {
    const { category_id } = req.params;
    if (!mongoose.isValidObjectId(category_id)) {
      return res.status(404).json({ error: 'category_not_found' });
    }

    // Best-effort fetch of the category name for the audit detail.
    // If the category was deleted in parallel, we still audit with
    // the id — the name is nice-to-have, not mandatory.
    const category = await Category.findById(category_id)
      .select('_id name')
      .lean();

    const existing = await CategoryIcon.findOneAndDelete({ category_id });
    if (!existing) {
      // Idempotent clear — nothing to do, nothing to audit. 204 is
      // the honest signal that the end state is "no icon" regardless
      // of what the caller thought was there.
      return res.status(204).end();
    }

    audit({
      action: 'category_icon_updated',
      userId: req.userId,
      ip: clientIp(req),
      detail:
        `category=${category?.name ?? category_id} ` +
        `icon=none previous=${existing.icon_name}`,
    });

    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
