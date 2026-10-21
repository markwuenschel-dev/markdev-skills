export function normalizeOrder(input) {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const segments = trimmed.split(",");
  return segments.map((segment) => segment.trim()).filter(Boolean);
}
