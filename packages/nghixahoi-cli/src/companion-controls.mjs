import {MINI_WORDS} from './mini-words.mjs';

// A word into an attribute of the title bar: the words are this package's own, but a word is never markup.
function text(value) {
  return String(value).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

export const COMPANION_HIDE_CSS = `
  .title-bar .dot-close {
    position: relative;
    z-index: 1;
    box-sizing: content-box;
    border: 0;
    padding: 6px;
    margin: -6px;
    display: grid;
    place-items: center;
    background: var(--red-color);
    background-clip: content-box;
    color: var(--bg-color);
    font: 700 9px/1 var(--font-mono);
    cursor: pointer;
    -webkit-app-region: no-drag;
  }

  .title-bar .dot-close::before {
    content: "×";
    opacity: 0;
  }

  .title-bar .dot-close:hover::before,
  .title-bar .dot-close:focus-visible::before {
    opacity: 1;
  }

  .title-bar .dot-close:focus-visible {
    outline: none;
  }
`;

// The Mini's title bar, in the Mini's words (src/mini-words.mjs): its tooltip, and the red dot's, which hides the Mini, and its name.
// `after`: the page's own markup after the three dots, since 2026-10-30 its update line (companion-window.mjs), at the bar's right end.
export function renderCompanionTitleBar(after = '') {
  return `<div class="title-bar" title="${text(MINI_WORDS.chrome.drag)}">
    <button class="dot filled dot-close" id="hideButton" data-testid="companion-hide" type="button" aria-label="${text(MINI_WORDS.chrome.hideName)}" title="${text(MINI_WORDS.chrome.hide)}"></button>
    <span class="dot" aria-hidden="true"></span>
    <span class="dot" aria-hidden="true"></span>${after}
  </div>`;
}
