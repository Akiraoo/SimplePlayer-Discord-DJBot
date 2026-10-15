// Small helpers without Discord dependencies.

export function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/** "1:23", "1:02:03" or "83" → seconds; null when it isn't a time. */
export function parseTime(text) {
  const t = String(text ?? '').trim();
  if (!/^\d+(:\d{1,2}){0,2}$/.test(t)) return null;
  return t.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
}

export function clip(text, max) {
  const s = String(text ?? '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
