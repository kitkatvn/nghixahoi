import crypto from 'node:crypto';
import fs from 'node:fs';

// What Welcome's and the Mini's pages share: their fonts, embedded, and their Content-Security-Policy.

// The latin subsets Google Fonts serves, as published in @fontsource/vt323 and @fontsource/fira-code
// 5.3.0, under the SIL Open Font License 1.1 (fonts/<family>/OFL.txt, from github.com/google/fonts).
// Embedded as data: URLs, so a page asks no server for them, whether it is a file, a data: URL or
// served by the tracker. A character outside the subset falls back to the next font in the stack.
// Since 2026-10-22 also JetBrains Mono, Welcome's alone, which speaks Vietnamese: its latin and vietnamese subsets, from
// @fontsource/jetbrains-mono 5.3.0, each with the unicode-range Google Fonts gives it, so that the two read as one font.
// Fira Code has no Vietnamese subset (docs/plans/2026-10-22-vietnamese-setup-and-welcome.md, "Fonts"); the Mini kept it until
// 2026-10-28, when it too began to speak Vietnamese, in JetBrains Mono (src/mini-words.mjs). No page embeds Fira Code since.
const JETBRAINS_MONO_RANGES = {
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  vietnamese: 'U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB',
};

const FONTS = {
  'vt323': {family: 'VT323', faces: [{weight: 400, file: 'vt323/vt323-latin-400-normal.woff2'}]},
  'fira-code': {
    family: 'Fira Code',
    faces: [400, 500, 700].map((weight) => ({weight, file: `fira-code/fira-code-latin-${weight}-normal.woff2`})),
  },
  'jetbrains-mono': {
    family: 'JetBrains Mono',
    faces: [400, 500, 700].flatMap((weight) => ['vietnamese', 'latin'].map((subset) => (
      {weight, file: `jetbrains-mono/jetbrains-mono-${subset}-${weight}-normal.woff2`, range: JETBRAINS_MONO_RANGES[subset]}
    ))),
  },
};

const fontFaceCache = new Map();

export function fontFaces(names) {
  const key = names.join(',');

  if (!fontFaceCache.has(key)) {
    fontFaceCache.set(key, names.flatMap((name) => FONTS[name].faces.map(({weight, file, range}) => {
      const data = fs.readFileSync(new URL(`./fonts/${file}`, import.meta.url)).toString('base64');
      return `@font-face{font-family:'${FONTS[name].family}';font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${data}) format('woff2')${range ? `;unicode-range:${range}` : ''}}`;
    })).join('\n'));
  }

  return fontFaceCache.get(key);
}

function sha256Source(text) {
  return `'sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

// Only the page's own inline script and stylesheet run, by their hashes; fonts come from data: URLs;
// the page connects only to `connect`, and nothing else loads, frames, submits or changes its base.
export function contentSecurityPolicy({script, style, connect = []}) {
  return [
    'default-src \'none\'',
    `script-src ${sha256Source(script)}`,
    `style-src ${sha256Source(style)}`,
    'font-src data:',
    `connect-src ${connect.length > 0 ? connect.join(' ') : '\'none\''}`,
    'base-uri \'none\'',
    'form-action \'none\'',
  ].join('; ');
}
