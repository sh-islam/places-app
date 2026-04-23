// Tiny helpers to turn snake_case keys into human-readable labels.

export function toLabel(key) {
  if (!key) return "";
  return key
    .split(/[_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}


// Item display name:
//   - Drop leading `admin_` prefix (admin-only items are displayed to admins
//     without exposing the access marker in the UI).
//   - Drop trailing `_<digits>` suffix (admin_girl_blue_dress_2 -> "Girl Blue Dress").
//   - Title Case. Multiple files can share the same display name; that's fine.
export function itemDisplayName(rawName) {
  const stripped = (rawName || "")
    .replace(/^admin_/, "")
    .replace(/_\d+$/, "");
  return toLabel(stripped);
}
