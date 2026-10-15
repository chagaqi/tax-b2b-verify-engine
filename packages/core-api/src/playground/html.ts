export function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Shared design tokens (light + dark) for every server-rendered page. */
export const BASE_CSS = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#1b2130;--muted:#5d6577;--line:#e3e6ec;--accent:#2563eb;--ok:#0f8a52;--warn:#b7791f;--bad:#c53030;--chip:#eef2ff;--on-badge:#fff;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0f131a;--card:#171c25;--ink:#e7eaf0;--muted:#9aa3b2;--line:#2a3140;--accent:#6ea0ff;--ok:#34c38f;--warn:#f0b44c;--bad:#ff6b6b;--chip:#1f2a44;--on-badge:#0f131a;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:920px;margin:0 auto;padding:24px 16px 48px}h1{font-size:24px;margin:8px 0 4px}h2{font-size:17px;margin:0 0 12px}
.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-top:16px}
a{color:var(--accent)}code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--chip);padding:1px 5px;border-radius:5px;word-break:break-all}
.badge{display:inline-block;padding:4px 10px;border-radius:999px;font-weight:600;font-size:13px;color:var(--on-badge)}
.ok{background:var(--ok)}.warn{background:var(--warn)}.bad{background:var(--bad)}.info{background:var(--accent)}
dl{display:grid;grid-template-columns:minmax(120px,190px) 1fr;gap:6px 14px;margin:14px 0 0}dt{color:var(--muted);font-size:13px}dd{margin:0;overflow-wrap:anywhere}
@media (max-width:560px){dl{grid-template-columns:1fr}dt{margin-top:6px}}
`;
