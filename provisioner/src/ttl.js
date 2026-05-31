// Parse a TTL string like "1h", "30m", "4h", "24h", "2d" into milliseconds.
const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseTtl(ttl) {
  const m = String(ttl).trim().match(/^(\d+)\s*([smhd])$/i);
  if (!m) throw new Error(`invalid duration "${ttl}" (use e.g. 30m, 1h, 4h, 24h, 2d)`);
  const value = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (value <= 0) throw new Error("duration must be > 0");
  const ms = value * UNITS[unit];
  if (ms > 7 * UNITS.d) throw new Error("duration cannot exceed 7d");
  return ms;
}

export function expiresAtFrom(ttl, now = Date.now()) {
  return new Date(now + parseTtl(ttl)).toISOString();
}
