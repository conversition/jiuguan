/** Trusted renderer shared by the preview player and visual-observer frame capture. */
type Point = { x: number; y: number };
export type DirectorGraphic = { geometry: { kind: 'rect' | 'ellipse' | 'line' | 'door' | 'lamp' | 'cup' | 'letter' | 'staff'; label: string; from: Point; to: Point;
  tone?: 'neutral' | 'warm' | 'light' | 'shadow'; motion?: { dx: number; dy: number; rotate: number } }[];
  figures: { id: string; label: string; from: Point; to: Point; gaze: Point;
    posture?: 'standing' | 'sitting'; gesture?: 'reach' | 'guard'; handMotion?: { from: Point; to: Point } }[] };

function point(value: Point): void {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y) || value.x < 0 || value.x > 1 || value.y < 0 || value.y > 1)
    throw new Error('director-graphic-invalid');
}
function escape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
const tones = {
  neutral: { fill: '#354962', stroke: '#8da4bf', opacity: '1' },
  warm: { fill: '#efb64f', stroke: '#ffe0a0', opacity: '1' },
  light: { fill: '#ffe49a', stroke: '#fff4c9', opacity: '0.65' },
  shadow: { fill: '#111827', stroke: '#718198', opacity: '1' },
} as const;
export function renderDirectorGraphic(shot: DirectorGraphic, progress: number, blind: boolean): string {
  if (!shot || !Array.isArray(shot.geometry) || !Array.isArray(shot.figures) || shot.geometry.length > 20 || shot.figures.length > 12
    || !Number.isFinite(progress) || progress < 0 || progress > 1) throw new Error('director-graphic-invalid');
  const shapes = shot.geometry.map(g => {
    if (!g || !['rect', 'ellipse', 'line', 'door', 'lamp', 'cup', 'letter', 'staff'].includes(g.kind) || typeof g.label !== 'string') throw new Error('director-graphic-invalid');
    if (g.tone !== undefined && !Object.hasOwn(tones, g.tone)) throw new Error('director-graphic-invalid');
    const style = tones[g.tone ?? 'neutral'];
    const opacity = style.opacity === '1' ? '' : ` opacity="${style.opacity}"`;
    point(g.from); point(g.to);
    if (g.motion !== undefined && (!g.motion || typeof g.motion !== 'object' || Object.keys(g.motion).some(k => !['dx', 'dy', 'rotate'].includes(k))
      || !Number.isFinite(g.motion.dx) || !Number.isFinite(g.motion.dy) || !Number.isFinite(g.motion.rotate)
      || Math.abs(g.motion.dx) > 1 || Math.abs(g.motion.dy) > 1 || Math.abs(g.motion.rotate) > 180
      || [g.from, g.to].some(p => p.x + g.motion!.dx < 0 || p.x + g.motion!.dx > 1 || p.y + g.motion!.dy < 0 || p.y + g.motion!.dy > 1)))
      throw new Error('director-graphic-invalid');
    const x = Math.min(g.from.x, g.to.x) * 1000, y = Math.min(g.from.y, g.to.y) * 600;
    const w = Math.abs(g.to.x - g.from.x) * 1000, h = Math.abs(g.to.y - g.from.y) * 600;
    const title = blind ? '' : `<title>${escape(g.label)}</title>`;
    const body = g.kind === 'door'
      ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#111827" stroke="#e4eeff" stroke-width="5"/><path d="M ${x + w * .06} ${y + h * .04} L ${x + w * .64} ${y + h * .13} L ${x + w * .64} ${y + h * .87} L ${x + w * .06} ${y + h * .96} Z" fill="${style.fill}" stroke="${style.stroke}" stroke-width="4"/><circle cx="${x + w * .51}" cy="${y + h * .53}" r="${Math.min(w, h) * .035}" fill="#ffe0a0"/>`
      : g.kind === 'lamp'
        ? `<line x1="${x + w * .5}" y1="${y}" x2="${x + w * .5}" y2="${y + h * .27}" stroke="#e4eeff" stroke-width="5"/><path d="M ${x + w * .34} ${y + h * .28} L ${x + w * .66} ${y + h * .28} L ${x + w * .82} ${y + h * .60} L ${x + w * .18} ${y + h * .60} Z" fill="${style.fill}" stroke="${style.stroke}" stroke-width="4"/><circle cx="${x + w * .5}" cy="${y + h * .62}" r="${Math.min(w, h) * .09}" fill="${style.stroke}"/>`
      : g.kind === 'cup'
      ? `<path d="M ${x + w * .08} ${y + h * .2} H ${x + w * .7} L ${x + w * .64} ${y + h * .82} Q ${x + w * .4} ${y + h * .94} ${x + w * .14} ${y + h * .82} Z" fill="${style.fill}" stroke="${style.stroke}" stroke-width="4"/><path d="M ${x + w * .7} ${y + h * .3} Q ${x + w * 1.05} ${y + h * .24} ${x + w * .9} ${y + h * .65} L ${x + w * .68} ${y + h * .65}" fill="none" stroke="${style.stroke}" stroke-width="4"/>`
      : g.kind === 'letter'
      ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${style.fill}" stroke="${style.stroke}" stroke-width="4"/><path d="M ${x} ${y} L ${x + w / 2} ${y + h * .55} L ${x + w} ${y}" fill="none" stroke="${style.stroke}" stroke-width="4"/><circle cx="${x + w / 2}" cy="${y + h * .55}" r="${Math.min(w,h) * .07}" fill="${style.stroke}"/>`
      : g.kind === 'staff'
      ? `<line x1="${g.from.x * 1000}" y1="${g.from.y * 600}" x2="${g.to.x * 1000}" y2="${g.to.y * 600}" stroke="${style.stroke}" stroke-width="9" stroke-linecap="round"${opacity}/>`
      : g.kind === 'line'
      ? `<line x1="${g.from.x * 1000}" y1="${g.from.y * 600}" x2="${g.to.x * 1000}" y2="${g.to.y * 600}" stroke="${style.stroke}" stroke-width="5"${opacity}/>`
      : g.kind === 'rect' ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${style.fill}" stroke="${style.stroke}" stroke-width="3"${opacity}/>`
        : `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${style.fill}" stroke="${style.stroke}" stroke-width="3"${opacity}/>`;
    const transform = g.motion ? ` transform="translate(${g.motion.dx * 1000 * progress} ${g.motion.dy * 600 * progress}) rotate(${g.motion.rotate * progress} ${x + w / 2} ${y + h / 2})"` : '';
    return `<g${transform}${g.kind === 'door' ? opacity : ''}>${title}${body}</g>`;
  }).join('');
  const figures = shot.figures.map(f => {
    if (!f || typeof f.label !== 'string') throw new Error('director-graphic-invalid');
    if (f.posture !== undefined && !['standing', 'sitting'].includes(f.posture)) throw new Error('director-graphic-invalid');
    if (f.gesture !== undefined && !['reach', 'guard'].includes(f.gesture)) throw new Error('director-graphic-invalid');
    point(f.from); point(f.to); point(f.gaze);
    if (f.handMotion !== undefined) {
      if (f.gesture !== 'reach' || !f.handMotion || typeof f.handMotion !== 'object'
          || Object.keys(f.handMotion).some(k => !['from', 'to'].includes(k))) throw new Error('director-graphic-invalid');
      point(f.handMotion.from); point(f.handMotion.to);
    }
    const x = (f.from.x + (f.to.x - f.from.x) * progress) * 1000, y = (f.from.y + (f.to.y - f.from.y) * progress) * 600;
    const label = blind ? '' : `<text x="${x + 25}" y="${y - 12}" fill="white" font-size="22">${escape(f.label)}</text>`;
    const direction = f.gaze.x < x / 1000 ? -1 : 1;
    // Keep the head/shoulder/hip anchors stable, but use recognizable human
    // proportions. A seated pose needs a visible thigh and shin, not a tiny notch.
    const body = f.posture ? `<path d="M ${x} ${y + 14} v 46 ${f.posture === 'sitting' ? `l ${direction * 42} 0 v 40 l ${direction * 12} 0 M ${x} ${y + 60} l ${direction * 32} 8 v 32 l ${direction * 12} 0` : 'l -22 40 m 22 -40 l 22 40'}" fill="none" stroke="#8de0ca" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>` : '';
    const handX = f.handMotion ? (f.handMotion.from.x + (f.handMotion.to.x - f.handMotion.from.x) * progress) * 1000 : x + direction * 48;
    const handY = f.handMotion ? (f.handMotion.from.y + (f.handMotion.to.y - f.handMotion.from.y) * progress) * 600 : y + 36;
    const arm = f.gesture === 'reach' ? `<path d="M ${x} ${y + 34} L ${handX} ${handY}" fill="none" stroke="#8de0ca" stroke-width="7" stroke-linecap="round"/>`
      : f.gesture === 'guard' ? `<path d="M ${x} ${y + 34} l ${direction * 20} -18 l ${direction * 12} 10" fill="none" stroke="#8de0ca" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>` : '';
    const movement = f.from.x === f.to.x && f.from.y === f.to.y ? '' : `<line x1="${f.from.x * 1000}" y1="${f.from.y * 600}" x2="${f.to.x * 1000}" y2="${f.to.y * 600}" stroke="#ffbf69" stroke-width="3" marker-end="url(#creative-arrow)"/>`;
    return `<g>${movement}<circle cx="${x}" cy="${y}" r="${f.posture ? 14 : 22}" fill="#8de0ca"/>${body}${arm}<line x1="${x}" y1="${y}" x2="${f.gaze.x * 1000}" y2="${f.gaze.y * 600}" stroke="#e4eeff" stroke-dasharray="8 7"/>${label}</g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 600" width="1000" height="600" style="width:100%;max-height:420px;background:#172034"><defs><marker id="creative-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#ffbf69"/></marker></defs><rect width="1000" height="600" fill="#172034"/>${shapes}${figures}</svg>`;
}
