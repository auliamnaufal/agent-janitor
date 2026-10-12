const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(n: number): string {
  if (n < 0) n = 0;
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const precision = unit === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${UNITS[unit]}`;
}

export function relativeTime(mtimeMs: number, now: number): string {
  const diff = Math.max(0, now - mtimeMs);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

export function pad(text: string, width: number): string {
  if (text.length >= width) return text;
  return text + " ".repeat(width - text.length);
}

export function padLeft(text: string, width: number): string {
  if (text.length >= width) return text;
  return " ".repeat(width - text.length) + text;
}
