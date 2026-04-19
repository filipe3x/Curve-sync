import mongoose from 'mongoose';

/**
 * CategoryIcon — Curve Sync's own icon-per-category mapping.
 *
 * Background: Embers stores category icons as a Paperclip attachment
 * on the `Category` model (`icon_file_name`, `icon_content_type`,
 * `icon_file_size`, `icon_fingerprint`, `icon_updated_at`). Those five
 * fields remain as inert ghost data on existing category docs (Embers
 * still reads them; `docs/embers-reference/models/category.rb:16` is
 * the source of truth) — we don't touch, rename, or clone them here.
 * The bytes live on Embers' filesystem under `public/system/...`,
 * which Curve Sync has no access path to, and reusing Paperclip on
 * Mongoose is cost that buys nothing since the full category CRUD now
 * lives on our side.
 *
 * Decision (see chat history of the Fase 5 work): ignore those fields
 * entirely and ship our own icon association keyed by `category_id`,
 * living in a Curve-Sync-owned collection. The source of truth for
 * the rendered glyph is `icon_name`, a Lucide component name the
 * client knows how to render via `client/src/components/common/
 * CategoryIcon.jsx`. The server validates against a whitelist
 * (`ALLOWED_ICON_NAMES` in the routes file) so a malicious or typo'd
 * POST can't write a name the client has no way to render.
 *
 * Access is global-read + admin-write — icons are catalogue-level,
 * not per-user. `GET /api/category-icons` returns the full mapping
 * for any authenticated user; `PUT` and `DELETE` are gated behind
 * `requireAdmin`. This matches the asymmetry on the parent
 * `categories` collection itself (§7.3 of docs/Categories.md).
 *
 * Why a separate collection instead of a single map doc — a per-doc
 * row keyed by `category_id` is O(1) upsert for the PUT path, lets
 * the unique index enforce "one icon per category" at the DB level,
 * and makes the delete path a trivial `deleteOne`. A single map doc
 * would need a `$set` on a dynamic key and opens the door to atomic-
 * ity questions on concurrent writes we'd rather not think about.
 */
const categoryIconSchema = new mongoose.Schema(
  {
    category_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
      unique: true,
    },
    // Lucide component name as exported by `lucide-react@1.8.0` (e.g.
    // "ShoppingCart", "Coffee", "Tag"). Validated at route level
    // against `ALLOWED_ICON_NAMES` — keeping the list in one place
    // lets us grow the whitelist without bumping the schema.
    icon_name: {
      type: String,
      required: true,
      trim: true,
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'curve_category_icons',
  },
);

// Hot query on GET: we fetch the whole mapping in one shot (<50 rows
// at MVP scale), so no extra index is needed beyond the unique one
// above. The PUT path upserts by `category_id` which is already
// covered by the `unique: true` index.

export default mongoose.model('CategoryIcon', categoryIconSchema);
