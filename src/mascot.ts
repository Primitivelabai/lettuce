// The lettuce ghost, as pixel rows. D = leaf edge, L = leaf, W = eye, K = pupil.
const ROWS = [
  '..D..DD..D..',
  '.DLLDLLDLLD.',
  'DLLLLLLLLLLD',
  '.LLLLLLLLLL.',
  '.LLWWLLWWLL.',
  '.LLWKLLWKLL.',
  '.LLLLLLLLLL.',
  '.LLLLLLLLLL.',
  '.LLLLLLLLLL.',
  '.LLLLLLLLLL.',
  '.LLLL..LLLL.',
  '.LL......LL.',
];

const FILL: Record<string, string> = { D: '#3f9e66', L: '#7ed9a2', W: '#ffffff', K: '#1c1915' };

/** Inline SVG, no outside resources, so it works under the page's strict content policy. */
export function mascotSvg(size: number, label = 'lettuce'): string {
  const rects: string[] = [];
  ROWS.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (FILL[c]) rects.push(`<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${FILL[c]}"/>`);
    }),
  );
  return `<svg class="mascot" width="${size}" height="${size}" viewBox="0 0 12 12" shape-rendering="crispEdges" ${label ? `role="img" aria-label="${label}"` : `aria-hidden="true"`}>${rects.join('')}</svg>`;
}
