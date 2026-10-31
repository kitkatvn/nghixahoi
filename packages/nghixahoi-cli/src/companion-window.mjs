import {COMPANION_HIDE_CSS, renderCompanionTitleBar} from './companion-controls.mjs';
import {DASHBOARD_URL} from './integration-spec.mjs';
import {MINI_WORDS} from './mini-words.mjs';
import {MINI_NUMBER_SCRIPT} from './number-format.mjs';
import {contentSecurityPolicy, fontFaces} from './window-page.mjs';

// A word into the page's markup, where it is text: the words are this package's own, but a word is never markup.
function text(value) {
  return String(value).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

// A word into the page's script: JSON, with every "<" escaped, so that no word can end the script element.
function scriptValue(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const [brandFirst, brandCounter] = MINI_WORDS.brand.counter.split('\n');
const secondLine = (word) => word.split('\n')[1];
// The dashboard's address as the update line names it, its host alone, from DASHBOARD_URL, which a release's copy writes
// (integration-spec.mjs); a tester build's names its staging site, and never shows the line (src/version-order.mjs).
const dashboardHost = new URL(DASHBOARD_URL).host;

export function renderCompanionWindow(apiBase = '') {
  // The words the page's script writes: the label's second line and its name, in cycle 1, from cycle 2 on, and once ended.
  const scriptWords = {
    counter: brandCounter,
    cycle: secondLine(MINI_WORDS.brand.cycle),
    ended: secondLine(MINI_WORDS.brand.ended),
    counterName: MINI_WORDS.brandName.counter,
    cycleName: MINI_WORDS.brandName.cycle,
    endedName: MINI_WORDS.brandName.ended,
    update: MINI_WORDS.update.replace('{HOST}', () => dashboardHost),
  };
  // The page's one stylesheet and one script, kept apart so that its policy allows exactly them. Served
  // by the tracker (apiBase ''), the page reads the API from its own origin; the offline copy, from apiBase.
  const style = `
${fontFaces(['vt323', 'jetbrains-mono'])}
:root{color-scheme:dark;--bg-color:#0c0c0c;--red-color:#f03030;--white-text:#e0e0e0;--font-mono:'JetBrains Mono',monospace;--font-pixel:'VT323',monospace}
*{box-sizing:border-box;margin:0;padding:0}
html,body{position:relative;width:100%;height:100%;margin:0;overflow:hidden;background:transparent;color:var(--white-text);font-family:var(--font-mono)}
button{cursor:pointer}
.widget-window{position:relative;width:100%;height:100%;display:flex;flex-direction:column;background:var(--bg-color);border:2px solid var(--red-color);border-radius:0;overflow:hidden;-webkit-app-region:drag}
.title-bar{padding:6px 10px 4px;display:flex;align-items:center;gap:7px;border-bottom:1px solid var(--red-color)}
.dot{width:12px;height:12px;border-radius:50%;border:1px solid var(--red-color);background:transparent}
.dot.filled{background-color:var(--red-color)}
.widget-body{flex:1;min-height:0;padding:8px 16px;display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0;-webkit-app-region:drag}
.brand-label{color:var(--red-color);font-family:var(--font-mono);font-size:10px;font-weight:700;line-height:1.15;letter-spacing:.6px;text-transform:uppercase;white-space:nowrap}
.percentage{font-family:var(--font-pixel),var(--font-mono);font-size:30px;letter-spacing:1px;line-height:1;color:var(--white-text);white-space:nowrap}
.progress-box{border-top:2px solid var(--white-text);border-bottom:2px solid var(--white-text);border-left:1px dashed var(--white-text);border-right:1px dashed var(--white-text);padding:3px 6px;width:120px;height:32px;display:flex;align-items:center;flex:0 0 120px;overflow:hidden}
.progress-fill{width:0;height:100%;display:flex;flex-direction:column;justify-content:center;gap:1px;overflow:hidden;transition:width .2s ease}
.progress-row{width:max-content;color:var(--white-text);font:700 9px/1 var(--font-mono);letter-spacing:1px;white-space:nowrap}
.metrics-group{display:flex;align-items:flex-end;gap:14px;min-width:0}
.metric-item{display:flex;flex-direction:column;align-items:center;min-width:0}
.metric-value{color:var(--white-text);font-family:var(--font-pixel),var(--font-mono);font-size:24px;line-height:1;margin-bottom:2px;letter-spacing:.5px;white-space:nowrap}
.metric-label{color:var(--red-color);font-family:var(--font-mono);font-size:7px;font-weight:500;letter-spacing:.3px;text-transform:uppercase;white-space:nowrap}
.claim-btn{-webkit-app-region:no-drag;background:transparent;color:var(--white-text);font-family:var(--font-mono);font-size:10px;font-weight:500;letter-spacing:1px;padding:3px 12px;cursor:pointer;text-transform:uppercase;border-top:2px solid var(--red-color);border-bottom:2px solid var(--red-color);border-left:1px dashed var(--red-color);border-right:1px dashed var(--red-color);white-space:normal;width:min-content;line-height:1.15;transition:background-color .2s ease}
.claim-btn:hover,.claim-btn:focus-visible{background:rgba(240,48,48,.15);outline:none}
.update-line{-webkit-app-region:no-drag;margin-left:auto;border:0;background:transparent;padding:1px 4px;color:var(--white-text);font:500 9px/1 var(--font-mono);letter-spacing:.6px;text-transform:uppercase;white-space:nowrap;transition:background-color .2s ease}
.update-line[hidden]{display:none}
.update-line:hover,.update-line:focus-visible{background:rgba(240,48,48,.15);outline:none}
.offline .percentage,.offline .metric-value{color:#6f6f6f}
.offline .progress-row{color:#6f6f6f}
${COMPANION_HIDE_CSS}
`;
  const script = `
const API_BASE=${JSON.stringify(apiBase)};const WORDS=${scriptValue(scriptWords)};const brandLabel=document.getElementById('brandLabel'),brandSecond=document.getElementById('brandSecond'),percent=document.getElementById('percent'),countValue=document.getElementById('countValue'),workedValue=document.getElementById('workedValue'),progressFill=document.getElementById('progressFill'),main=document.getElementById('main'),dashboardButton=document.getElementById('dashboardButton'),updateLine=document.getElementById('updateLine');
function withCycle(word,cycle){return word.replace('{N}',()=>String(cycle))}
${MINI_NUMBER_SCRIPT}
function showValue(element,shown,full){element.textContent=shown;element.title=shown===full?'':full}
function updateProgress(value){progressFill.style.width=Math.max(0,Math.min(100,Number(value)||0))+'%'}
function showUpdate(version){const plain=typeof version==='string'&&/^(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})$/.test(version);updateLine.textContent=plain?WORDS.update.replace('{V}',()=>version):'';updateLine.hidden=!plain}
function render(summary){const reward=summary?.reward||{},global=summary?.global||{},value=Math.max(0,Math.min(100,Math.floor(Number(reward.progressPercent)||0))),cycle=Number.isSafeInteger(reward.cycle)&&reward.cycle>1?reward.cycle:null,ended=reward.campaign?.ended===true;brandSecond.textContent=ended?WORDS.ended:cycle===null?WORDS.counter:withCycle(WORDS.cycle,cycle);brandLabel.setAttribute('aria-label',ended?WORDS.endedName:cycle===null?WORDS.counterName:withCycle(WORDS.cycleName,cycle));percent.textContent=value+'%';const equals=Math.max(0,Math.floor(Number(reward.totalEquals)||0));showValue(countValue,shortNumber(equals),groupedNumber(equals));showValue(workedValue,focusTime(global.totalActiveSeconds),focusTimeFull(global.totalActiveSeconds));updateProgress(value);showUpdate(summary?.update?.version);main.classList.remove('offline')}
function offline(){percent.textContent='--';showValue(countValue,'--','--');showValue(workedValue,'--','--');updateProgress(0);showUpdate(null);main.classList.add('offline')}
async function sync(){try{const response=await fetch(API_BASE+'/api/summary');if(!response.ok)throw new Error();render(await response.json())}catch{offline()}}
const hideButton=document.getElementById('hideButton');function hideCompanion(){try{const result=window.nghixahoiCompanion?.hide?.();if(result&&typeof result.catch==='function')result.catch(()=>window.close());if(!result)window.close()}catch{window.close()}}
hideButton.addEventListener('pointerdown',(event)=>event.stopPropagation());hideButton.addEventListener('click',(event)=>{event.stopPropagation();hideCompanion()});
dashboardButton.addEventListener('pointerdown',(event)=>event.stopPropagation());
function openDashboard(){if(window.nghixahoiCompanion?.openDashboard){window.nghixahoiCompanion.openDashboard();return}window.open(${JSON.stringify(DASHBOARD_URL)},'_blank','noopener')}
dashboardButton.addEventListener('click',openDashboard);
updateLine.addEventListener('pointerdown',(event)=>event.stopPropagation());updateLine.addEventListener('click',openDashboard);
sync();const events=new EventSource(API_BASE+'/api/events');events.addEventListener('summary',(event)=>{try{render(JSON.parse(event.data))}catch{offline()}});events.onerror=offline;
`;

  // Since 2026-10-22 its label names the cycle counted in from cycle 2 on, "KIT=CODE CYCLE 2" where it says "KIT=CODE COUNTER",
  // on the same two lines, so that the counters keep their room (docs/reward-rules.md §2, "Cycles"); its percent is that
  // cycle's, as the summary's is. Since 2026-10-23 (tracking/2-cli; D4 of docs/plans/2026-10-22-server-tracking-config.md) it
  // reads "KIT=CODE ENDED" once the summary says the campaign has ended, `reward.campaign.ended`, whatever the cycle; the counters
  // go on, as counting does.
  //
  // The button opens the dashboard, where each milestone reached shows its message: "See more". Until 2026-10-01 it was
  // "Show code", and lit while a 10–30 % code was ready to show there; the break codes are gone (the operator's decision
  // 6), and a milestone reached stays reached, so nothing lights it now. The Mini cannot show a message itself: the
  // messages are the claim backend's, and the tracker, which serves this page, never talks to it. Two short words, which
  // wrap onto two lines, as KIT=CODE COUNTER does on the left: "Dashboard" or "Messages" took 28 to 35 px more, and the
  // counters then ran into each other at long-campaign values (measured in the 560 x 76 window with 2500 = and
  // 11h 48m, 2026-09-24 and 2026-10-01).
  //
  // Since 2026-10-28 in Vietnamese, in JetBrains Mono, which has every Vietnamese letter (Fira Code has 33 of the 134), its
  // counters still in VT323: the client's words for the label, the two counters and the button, and drafts for the rest
  // (src/mini-words.mjs; docs/plans/2026-10-28-vietnamese-mini-dashboard-claims.md, phase 3). The idle counter is gone, as the
  // deck says ("remove"): the dashboard keeps the focus time. Whole at 560 x 76 with 2500 = and 11h 48m, in each state, the
  // ink of the label's stacked capitals included (apps/web/e2e/cli-windows.spec.ts).
  //
  // Since 2026-10-30 (web/7-update-notice; the operator's of 2026-10-29), while a newer Kit=Code is out, one line at the right of the
  // title bar, opposite the dots, "CÓ BẢN MỚI 0.2.11 · MỞ <THE DASHBOARD'S HOST>", which opens the dashboard, as the button does: in the title
  // bar's own height, so that the window keeps its 560 × 76 and the row under it is unchanged (measured by the prototype of 2026-10-29,
  // held by apps/web/e2e/cli-windows.spec.ts). Its version is the summary's `update.version` (runtime.mjs, buildSummary), x.y.z alone;
  // hidden while there is none, and while the tracker does not answer.
  //
  // Since 2026-10-30 (web/13-number-format; the operator's "add thousand seperater , to numbers ... and what if the numbers are too long?
  // in the minibar"), the counters are written by src/number-format.mjs, whose functions the script declares from their source: the =
  // with commas, "2,500", to 999,999, and from 1,000,000 one decimal and "M", "1.2M", the full number its tooltip; focus time from 1,000
  // hours in whole hours, "1,234h", its minutes in the tooltip. Whole at 560 × 76 at 999,999, 1.2M and 12.5M =, and at 999h 59m, 1,234h
  // and 12,345h (apps/web/e2e/cli-windows.spec.ts).
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy({script, style, connect: [apiBase || "'self'"]})}"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${text(MINI_WORDS.title)}</title><style>${style}</style></head>
<body><main class="widget-window" id="main" data-testid="companion-counter-bar">${renderCompanionTitleBar(`<button class="update-line" id="updateLine" data-testid="mini-update" type="button" title="${text(MINI_WORDS.updateTitle)}" hidden></button>`)}<div class="widget-body"><div class="brand-label" id="brandLabel" aria-label="${text(MINI_WORDS.brandName.counter)}" data-testid="mini-brand">${text(brandFirst)}<br><span id="brandSecond">${text(brandCounter)}</span></div><strong class="percentage" id="percent" data-testid="mini-percent">--</strong><div class="progress-box" aria-hidden="true"><div class="progress-fill" id="progressFill"><div class="progress-row">========================</div><div class="progress-row">========================</div></div></div><div class="metrics-group" aria-label="${text(MINI_WORDS.counters)}"><div class="metric-item"><div class="metric-value" id="countValue" data-testid="mini-count">--</div><div class="metric-label">${text(MINI_WORDS.equals)}</div></div><div class="metric-item"><div class="metric-value" id="workedValue" data-testid="mini-worked">--</div><div class="metric-label">${text(MINI_WORDS.worked)}</div></div></div><button class="claim-btn" id="dashboardButton" data-testid="companion-dashboard" type="button" title="${text(MINI_WORDS.seeMoreTitle)}">${text(MINI_WORDS.seeMore)}</button></div></main><script>${script}</script></body></html>`;
}
