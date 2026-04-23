// Tiny helpers to turn snake_case keys into human-readable labels.

export function toLabel(key) {
  if (!key) return "";
  return key
    .split(/[_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}


// Item display name:
//   - Drop trailing `_<digits>` suffix (bush_2 -> "Bush").
//   - Drop trailing `(<digits>)` — common OS-duplicate naming like
//     "flower (2).png" displays as "Flower", matching how _2 works.
//   - Title Case. The `admin_` prefix is KEPT so superadmin-only items
//     display as "Admin Girl Blue Dress" — a visible reminder that it's
//     the restricted-tier content (only superadmins ever see these).
export function itemDisplayName(rawName) {
  const stripped = (rawName || "")
    .replace(/\s*\(\d+\)$/, "")   // "flower (2)" -> "flower"
    .replace(/_\d+$/, "");         // "bush_2"     -> "bush"
  return toLabel(stripped);
}
