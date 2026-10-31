import {diagnosticsEnabled} from './diagnostics.mjs';
import {
  renderPlatformChrome,
  resolveSetupPlatform,
  setupPlatformTheme,
} from './onboarding-platform.mjs';
import {contentSecurityPolicy, fontFaces} from './window-page.mjs';
import {WELCOME_ENGLISH, WELCOME_TESTER_WORDS, WELCOME_WORDS} from './welcome-words.mjs';

// A word into the page's markup, where it is text: the words are this package's own, but a word is never markup.
function text(value) {
  return String(value).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

// A word into the page's script: JSON, with every "<" escaped, so that no word can end the script element.
function scriptValue(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

// `diagnostics`: whether this is a tester build (src/diagnostics.mjs), unless a test says. Then, and only then, Welcome says
// that the build sends diagnostic logs to Kit=Code's server, and what they never hold, and asks, optionally, for the email the
// tester was invited with, so that staff can find their logs by it (rows 78-80 of the words file, since 2026-10-22 in
// Vietnamese: src/welcome-words.mjs). Without it the page holds none of those words.
export function renderOnboardingWindow(platform = resolveSetupPlatform(), {diagnostics = diagnosticsEnabled()} = {}) {
  const theme = setupPlatformTheme(platform);
  // The words the page's script writes, and nothing else: a tester build's words are in its markup alone, so any other
  // build's page holds none of them.
  const scriptWords = {
    messages: WELCOME_WORDS.messages,
    buttons: WELCOME_WORDS.buttons,
    projects: {empty: WELCOME_WORDS.projects.empty, removeTitle: WELCOME_WORDS.projects.removeTitle, removeName: WELCOME_WORDS.projects.removeName},
    english: {pending: WELCOME_ENGLISH.pending, tracked: WELCOME_ENGLISH.tracked, added: WELCOME_ENGLISH.added},
  };
  // The page's one stylesheet and one script, kept apart so that its policy allows exactly them.
  const style = `
    ${fontFaces(['jetbrains-mono'])}

    :root {
      color-scheme: dark;
      --bg-color: #111113;
      --red-color: #e51324;
      --grey-border: #555558;
      --grey-text: #88888e;
      --white-text: #e1e1e6;
      --error: #ff9d9d;
      --font-mono: 'JetBrains Mono', 'Courier New', Courier, ui-monospace, monospace;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    html, body {
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: transparent;
      color: var(--white-text);
      font: 11px/1.4 var(--font-mono);
      -webkit-font-smoothing: antialiased;
    }

    button, input { font: inherit; }
    button, .option { cursor: pointer; }
    button:disabled { cursor: not-allowed; }

    .tech-box-red {
      border-top: 3px solid var(--red-color);
      border-bottom: 3px solid var(--red-color);
      border-left: 2px dashed var(--red-color);
      border-right: 2px dashed var(--red-color);
    }

    .tech-box-grey {
      border-top: 3px solid var(--grey-border);
      border-bottom: 3px solid var(--grey-border);
      border-left: 2px dashed var(--grey-border);
      border-right: 2px dashed var(--grey-border);
    }

    .tech-box-white {
      border-top: 3px solid var(--white-text);
      border-bottom: 3px solid var(--white-text);
      border-left: 2px dashed var(--white-text);
      border-right: 2px dashed var(--white-text);
    }

    .dashed-divider, .section-divider {
      color: var(--red-color);
      font-size: 11px;
      letter-spacing: 1px;
      overflow: hidden;
      white-space: nowrap;
      margin: 14px 0;
      width: 100%;
      user-select: none;
      opacity: 0.85;
      line-height: 1;
    }

    .shell.window {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      background: var(--bg-color);
      border: 1px solid var(--red-color);
      border-radius: 8px;
      overflow: hidden;
    }

    .title-bar {
      height: 38px;
      padding: 0 16px;
      display: flex;
      align-items: center;
      gap: 8px;
      border-bottom: 1px solid var(--red-color);
      -webkit-app-region: drag;
    }

    .dot {
      width: 13px;
      height: 13px;
      border-radius: 50%;
      border: 1px solid var(--red-color);
      padding: 0;
      background: transparent;
    }

    .dot.filled { background-color: var(--red-color); }

    .dot.dot-close {
      position: relative;
      z-index: 1;
      box-sizing: content-box;
      border: 0;
      padding: 7px;
      margin: -7px;
      display: grid;
      place-items: center;
      background-clip: content-box;
      color: var(--bg-color);
      font: 700 10px/1 var(--font-mono);
      cursor: pointer;
      -webkit-app-region: no-drag;
    }

    .dot.dot-close::before {
      content: "×";
      opacity: 0;
    }

    .dot.dot-close:hover::before,
    .dot.dot-close:focus-visible::before { opacity: 1; }

    .dot.dot-close:focus-visible { outline: none; }

    .container {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
      padding: 16px 28px 20px;
    }

    .top-tag {
      text-align: right;
      color: var(--white-text);
      font-size: 11px;
      margin-bottom: 4px;
    }

    .workspace.layout {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      gap: 60px;
      padding: 24px 0 30px;
      overflow: auto;
    }

    .steps-panel { min-height: 0; }

    .sidebar {
      width: 150px;
      flex: 0 0 150px;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
    }

    .rail-item {
      display: flex;
      align-items: center;
      gap: 12px;
      color: var(--grey-text);
    }

    .rail-item.is-active { color: var(--red-color); }

    .rail-item:not(.is-active) .rail-badge {
      border-color: var(--grey-border);
    }

    .rail-badge {
      padding: 3px 6px;
      font-weight: 700;
      font-size: 11px;
    }

    .rail-label {
      font-size: 10px;
      line-height: 1.3;
      font-weight: 700;
    }

    .step-connector {
      width: 1px;
      height: 32px;
      border-left: 2px dashed var(--red-color);
      margin: 6px 0 6px 13px;
    }

    .content {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 32px;
    }

    .section-title {
      font-size: 11px;
      margin-bottom: 12px;
      letter-spacing: 0.5px;
      color: var(--white-text);
      font-weight: 500;
      text-transform: uppercase;
    }

    .step { border: 0; margin: 0; padding: 0; min-width: 0; }

    .option-group {
      display: flex;
      gap: 15px;
    }

    .option {
      position: relative;
      height: 38px;
      flex: 0 0 auto;
    }

    .option input {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      clip-path: inset(50%);
      white-space: nowrap;
    }

    /* At least 72 px, as the English answers were, and as wide as its words with 12 px either side: "[ KHÔNG ]" filled a
       72 px card, while "[ CÓ ]" keeps the 72 px it had, with about 13 px either side. */
    .option-card {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 72px;
      height: 38px;
      background: transparent;
      padding: 0 12px;
      white-space: nowrap;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.5px;
      cursor: pointer;
      user-select: none;
      color: var(--grey-text);
    }

    .option-card.btn-red { color: var(--red-color); }
    .option-card.btn-grey { color: var(--grey-text); }

    .option input + .option-card {
      color: var(--grey-text);
      border-top-color: var(--grey-border);
      border-bottom-color: var(--grey-border);
      border-left-color: var(--grey-border);
      border-right-color: var(--grey-border);
    }

    .option input:checked + .option-card {
      color: var(--red-color);
      border-top-color: var(--red-color);
      border-bottom-color: var(--red-color);
      border-left-color: var(--red-color);
      border-right-color: var(--red-color);
    }

    .option input:focus-visible + .option-card {
      outline: none;
      box-shadow: inset 0 0 0 1px var(--red-color);
    }

    .step-head {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }

    .step-head .section-title { margin-bottom: 0; }

    .project-count {
      margin-left: auto;
      color: var(--red-color);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      display: none;
    }

    .projects-step {
      display: flex;
      flex-direction: column;
      min-height: 0;
      flex: 1 1 auto;
    }

    .project-list {
      min-height: 120px;
      max-height: 180px;
      overflow: auto;
      margin-bottom: 16px;
      scrollbar-color: var(--red-color) var(--bg-color);
    }

    .project-list.is-empty {
      padding: 40px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      color: var(--grey-text);
      overflow: hidden;
      scrollbar-width: none;
    }

    .project-list.is-empty::-webkit-scrollbar { display: none; }

    .dropzone-icon {
      width: 22px;
      height: 18px;
      stroke: var(--grey-text);
      fill: none;
      stroke-width: 1.5;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      font-size: 11px;
    }

    .project-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 9px;
      min-height: 38px;
      padding: 5px 8px;
      border-bottom: 1px dashed rgba(240, 48, 48, 0.25);
    }

    .project-row:last-child { border-bottom: 0; }
    .project-row[data-kind="pending"] { background: rgba(240, 48, 48, 0.06); }

    .project-copy { min-width: 0; }

    .project-name,
    .project-path {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .project-name { color: var(--white-text); font-weight: 700; }
    .project-path { color: var(--grey-text); font-size: 10px; }
    .project-meta { color: var(--grey-text); font-size: 9px; font-weight: 700; }
    .project-row[data-kind="pending"] .project-meta { color: var(--red-color); }

    .project-actions {
      display: flex;
      align-items: center;
      gap: 20px;
    }

    .hint {
      color: var(--white-text);
      font-size: 10px;
      line-height: 1.4;
      text-transform: uppercase;
    }

    .terminal-button {
      background: transparent;
      color: var(--red-color);
      padding: 8px 18px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.5px;
      cursor: pointer;
      -webkit-app-region: no-drag;
    }

    .terminal-button:hover,
    .terminal-button:focus-visible,
    .remove-project:hover,
    .remove-project:focus-visible {
      background: rgba(240, 48, 48, 0.12);
      outline: none;
    }

  .remove-project {
      width: 25px;
      height: 25px;
      border: 1px dashed var(--grey-border);
      background: transparent;
      color: var(--grey-text);
      cursor: pointer;
    }

    .content-footer.footer-action {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin: 12px 0;
    }

    /* The message line takes two lines when a message needs them, as the deck writes rows 66 and 76 (the plan's question
       5c): never cut with an ellipsis. A message's own line break is the deck's. */
    .message.comment-text {
      min-width: 0;
      color: var(--white-text);
      font-size: 11px;
      white-space: pre-line;
      overflow-wrap: break-word;
    }

    .message[data-state="error"] { color: var(--error); }
    .message[data-state="success"] { color: var(--red-color); }

    .primary-button { white-space: nowrap; }

    button:disabled { cursor: not-allowed; opacity: 0.48; }

    .statusline.status-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 10px;
      color: var(--white-text);
      margin-top: 4px;
    }

    .normal-mode.status-mode {
      padding: 2px 6px;
      font-weight: 700;
      color: var(--red-color);
    }

    .status-text {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .status-text[data-state="error"] { color: var(--error); }
    .status-text[data-state="success"] { color: var(--red-color); }

    .keyboard-hint.status-shortcuts { color: var(--white-text); }
${diagnostics ? `
    /* With a third step the steps outgrow the panel at the window's own 960 x 640: the projects step must not shrink, as it
       does alone to fill the panel, or its list and + ADD PROJECTS spill under the diagnostics step, whose email field then
       takes their clicks (found 2026-10-02). The panel scrolls instead, as its rail expects. */
    .projects-step { flex: 0 0 auto; }

    .diagnostics-step p { color: var(--white-text); font-size: 10px; line-height: 1.5; margin-bottom: 10px; max-width: 560px; }

    .diagnostics-step label { display: block; color: var(--grey-text); font-size: 10px; margin-bottom: 6px; }

    .diagnostics-step input {
      width: 100%;
      max-width: 360px;
      padding: 7px 9px;
      background: transparent;
      color: var(--white-text);
      border: 1px dashed var(--grey-border);
      -webkit-app-region: no-drag;
    }

    .diagnostics-step input:focus-visible { outline: none; border-color: var(--red-color); }
` : ''}  `;
  const script = `
    const bridge = window.nghixahoiOnboarding;
    const projectList = document.getElementById('projectList');
    const projectCount = document.getElementById('projectCount');
    const message = document.getElementById('message');
    const statusText = document.getElementById('statusText');
    const pickFolders = document.getElementById('pickFolders');
    const saveButton = document.getElementById('saveButton');
    const setupContent = document.getElementById('setupContent');
    const railItems = [...document.querySelectorAll('.rail-item')];
    const stepSections = [...document.querySelectorAll('[data-setup-step]')];
    const WORDS = ${scriptValue(scriptWords)};${diagnostics ? `
    const invitedEmail = document.getElementById('invitedEmail');` : ''}
    const FOLDER_ICON = '<svg class="dropzone-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
    // A word with its count or name in place, by a function, so that a "$&" in a folder's name stays the name's own.
    function fill(template, values) {
      return template.replace(/\\{(N|name)\\}/g, (_match, key) => String(values[key]));
    }

    let persistedProjects = [];
    let pendingProjects = [];
    let saving = false;

    function projectName(project) {
      const parts = String(project.repoRoot || '').split(/[\\\\/]/).filter(Boolean);
      return parts[parts.length - 1] || project.repoRoot || 'project';
    }

    function knownProjectIds() {
      return new Set(persistedProjects.concat(pendingProjects).map((project) => project.id));
    }

    function formatStatus(status) {
      const value = status || 'setup:ready';
      return value.startsWith('+++') ? value : '+++ ' + value + ' +++';
    }

    function setFeedback(text, state, status) {
      message.textContent = text.startsWith('/*') ? text : '/* ' + text;
      message.dataset.state = state || 'normal';
      statusText.textContent = formatStatus(status);
      statusText.dataset.state = state || 'normal';
    }

    function setActiveRailStep(stepId) {
      if (!stepId) return;
      railItems.forEach((item) => {
        item.classList.toggle('is-active', item.dataset.step === stepId);
      });
    }

    function bindStepRailSpy() {
      const observer = new IntersectionObserver((entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => right.intersectionRatio - left.intersectionRatio);
        if (visible[0]) {
          setActiveRailStep(visible[0].target.dataset.setupStep);
        }
      }, {
        root: setupContent,
        threshold: [0.35, 0.55, 0.75],
      });

      stepSections.forEach((section) => observer.observe(section));
      setupContent.addEventListener('focusin', (event) => {
        const section = event.target.closest('[data-setup-step]');
        if (section) setActiveRailStep(section.dataset.setupStep);
      });
    }

    function createProjectRow(project, kind) {
      const row = document.createElement('div');
      const copy = document.createElement('div');
      const name = document.createElement('span');
      const path = document.createElement('span');
      const meta = document.createElement('span');
      const remove = document.createElement('button');

      row.className = 'project-row';
      row.dataset.kind = kind;
      row.dataset.testid = kind === 'pending' ? 'pending-project-row' : 'persisted-project-row';
      row.setAttribute('role', 'listitem');
      row.title = project.repoRoot;
      copy.className = 'project-copy';
      name.className = 'project-name';
      name.textContent = projectName(project);
      path.className = 'project-path';
      path.textContent = project.repoRoot;
      meta.className = 'project-meta';
      meta.lang = 'en';
      meta.textContent = (project.sourceType || 'vibe').toUpperCase() + ' · ' + (kind === 'pending' ? WORDS.english.pending : WORDS.english.tracked);
      copy.append(name, path);
      row.append(copy, meta);

      remove.className = 'remove-project';
      remove.type = 'button';
      remove.dataset.testid = 'remove-project';
      remove.textContent = 'x';
      remove.title = WORDS.projects.removeTitle;
      remove.setAttribute('aria-label', fill(WORDS.projects.removeName, {name: projectName(project)}));
      remove.addEventListener('click', async () => {
        if (kind === 'pending') {
          pendingProjects = pendingProjects.filter((candidate) => candidate.id !== project.id);
          renderProjects();
          setFeedback(WORDS.messages.removed, 'normal', 'projects:removed');
          return;
        }

        if (!bridge?.removeProject) {
          persistedProjects = persistedProjects.filter((candidate) => candidate.id !== project.id);
          renderProjects();
          setFeedback(WORDS.messages.removedFromSetup, 'normal', 'projects:removed');
          return;
        }

        remove.disabled = true;
        try {
          const result = await bridge.removeProject(project.id);
          if (!result.ok) {
            remove.disabled = false;
            setFeedback(result.error || WORDS.messages.removeFailed, 'error', 'error:remove-project');
            return;
          }
          persistedProjects = Array.isArray(result.projects)
            ? result.projects
            : persistedProjects.filter((candidate) => candidate.id !== project.id);
          renderProjects();
          setFeedback(WORDS.messages.removed, 'normal', 'projects:removed');
        } catch {
          remove.disabled = false;
          setFeedback(WORDS.messages.removeFailedRetry, 'error', 'error:remove-project');
        }
      });
      row.append(remove);

      return row;
    }

    function renderProjects() {
      projectList.textContent = '';
      const projects = persistedProjects.concat(pendingProjects);
      projectCount.textContent = fill(WORDS.english.added, {N: projects.length});
      projectList.classList.toggle('is-empty', !projects.length);
      projectList.classList.toggle('tech-box-white', !projects.length);

      if (!projects.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.innerHTML = FOLDER_ICON;
        const label = document.createElement('span');
        label.textContent = WORDS.projects.empty;
        empty.append(label);
        projectList.append(empty);
        return;
      }

      persistedProjects.forEach((project) => projectList.append(createProjectRow(project, 'persisted')));
      pendingProjects.forEach((project) => projectList.append(createProjectRow(project, 'pending')));
    }

    function syncOptionGroup(group) {
      const radios = [...group.querySelectorAll('input[type="radio"]')];
      radios.forEach((radio) => {
        if (document.activeElement !== radio) radio.tabIndex = radio.checked ? 0 : -1;
        radio.setAttribute('aria-checked', String(radio.checked));
      });
    }

    function focusNextSection(group) {
      const next = document.getElementById(group.dataset.nextFocus);
      if (next) next.focus();
    }

    function bindOptionGroup(group) {
      const radios = [...group.querySelectorAll('input[type="radio"]')];
      radios.forEach((radio) => radio.addEventListener('change', () => syncOptionGroup(group)));
      group.addEventListener('keydown', (event) => {
        if (!radios.includes(event.target)) return;
        const index = radios.indexOf(event.target);

        if (event.key === 'ArrowDown' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
          event.preventDefault();
          const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
          const next = radios[(index + delta + radios.length) % radios.length];
          radios.forEach((radio) => { radio.tabIndex = -1; });
          next.tabIndex = 0;
          next.focus();
          statusText.textContent = formatStatus('select:space-or-enter');
          return;
        }

        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          event.target.checked = true;
          event.target.dispatchEvent(new Event('change', {bubbles: true}));
          if (event.key === 'Enter') focusNextSection(group);
        }
      });
      syncOptionGroup(group);
    }

    function setBusy(busy) {
      saving = busy;
      pickFolders.disabled = busy;
      saveButton.disabled = busy;
      document.querySelectorAll('.option input, .remove-project').forEach((control) => { control.disabled = busy; });
    }

    bindOptionGroup(document.getElementById('autoTrackGroup'));
    bindStepRailSpy();
    renderProjects();

    pickFolders.addEventListener('click', async () => {
      setFeedback(WORDS.messages.picking, 'normal', 'projects:select');
      try {
        const result = await bridge.selectFolders();
        if (result.canceled) {
          setFeedback(WORDS.messages.pickCanceled, 'normal', 'projects:unchanged');
          return;
        }

        const known = knownProjectIds();
        let duplicates = 0;
        for (const project of result.projects || []) {
          if (known.has(project.id)) {
            duplicates += 1;
            continue;
          }
          known.add(project.id);
          pendingProjects.push(project);
        }
        renderProjects();
        const added = (result.projects || []).length - duplicates;
        setFeedback(
          added ? fill(WORDS.messages.readyToAdd, {N: added}) : WORDS.messages.alreadyAdded,
          'normal',
          duplicates ? 'projects:deduplicated' : 'projects:pending'
        );
      } catch {
        setFeedback(WORDS.messages.pickerFailed, 'error', 'error:folder-picker');
      }
    });

    saveButton.addEventListener('click', async () => {
      if (saving) return;
      if (!persistedProjects.length && !pendingProjects.length) {
        setFeedback(WORDS.messages.noProjects, 'error', 'error:no-projects');
        pickFolders.focus();
        return;
      }

      setBusy(true);
      saveButton.textContent = WORDS.buttons.saving;
      setFeedback(WORDS.messages.saving, 'normal', 'setup:save');
      const autoTrack = document.querySelector('input[name="autoTrack"]:checked').value === 'yes';
      const companionView = 'mini';

      try {
        const result = await bridge.submit({
          folders: pendingProjects.map((project) => project.repoRoot),
          autoTrack,
          companionView,${diagnostics ? `
          invitedEmail: invitedEmail.value,` : ''}
        });

        if (Array.isArray(result.projects)) {
          persistedProjects = result.projects;
          const persistedIds = new Set(persistedProjects.map((project) => project.id));
          pendingProjects = pendingProjects.filter((project) => !persistedIds.has(project.id));
          renderProjects();
        }

        if (!result.ok) {
          setBusy(false);
          saveButton.textContent = WORDS.buttons.retry;
          setFeedback(result.error || WORDS.messages.saveFailed, 'error', 'error:retry-available');
          return;
        }

        saveButton.textContent = WORDS.buttons.saved;
        setFeedback(WORDS.messages.saved, 'success', 'setup:complete');
      } catch {
        setBusy(false);
        saveButton.textContent = WORDS.buttons.retry;
        setFeedback(WORDS.messages.requestFailed, 'error', 'error:retry-available');
      }
    });

    function closeSetup() {
      try {
        const result = bridge?.close();
        if (result && typeof result.catch === 'function') result.catch(() => window.close());
        if (!result) window.close();
      } catch {
        window.close();
      }
    }

    const closeButton = document.getElementById('closeButton');
    closeButton.addEventListener('pointerdown', (event) => event.stopPropagation());
    closeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      closeSetup();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !saving) closeSetup();
    });

    if (!bridge) {
      setBusy(true);
      setFeedback(WORDS.messages.noBridge, 'error', 'error:preload');
    } else {
      bridge.initialState().then((state) => {
        persistedProjects = Array.isArray(state.projects) ? state.projects : [];
        const known = knownProjectIds();
        let suggestedCount = 0;

        for (const project of state.suggestedProjects || []) {
          if (known.has(project.id)) {
            continue;
          }
          known.add(project.id);
          pendingProjects.push(project);
          suggestedCount += 1;
        }

        document.querySelector('input[name="autoTrack"][value="' + (state.autoTrack === false ? 'no' : 'yes') + '"]').checked = true;${diagnostics ? `
        invitedEmail.value = typeof state.invitedEmail === 'string' ? state.invitedEmail : '';` : ''}
        document.querySelectorAll('.option-group').forEach(syncOptionGroup);
        renderProjects();

        if (suggestedCount) {
          setFeedback(
            fill(WORDS.messages.suggested, {N: suggestedCount}),
            'normal',
            'projects:chat-suggested'
          );
        } else {
          setFeedback(
            persistedProjects.length ? fill(WORDS.messages.loaded, {N: persistedProjects.length}) : WORDS.messages.ready,
            'normal',
            persistedProjects.length ? 'projects:loaded' : 'setup:ready'
          );
        }
      }).catch(() => {
        renderProjects();
        setFeedback(WORDS.messages.stateFailed, 'error', 'error:initial-state');
      });
    }
  `;

  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy({script, style})}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${text(WELCOME_WORDS.title)}</title>
  <style>${style}</style>
</head>
<body data-platform="${theme.id}" data-theme-marker="${theme.marker}">
  <main class="shell window" data-testid="setup-shell">
    ${renderPlatformChrome(theme)}
    <div class="container">
      <div class="top-tag" lang="en">${text(WELCOME_ENGLISH.topTag)}</div>
      <div class="dashed-divider section-divider" aria-hidden="true">==================================================================================================================================================================================================</div>
      <div class="workspace layout steps-panel" id="setupContent" data-testid="setup-step-rail">
        <aside class="sidebar">
          <div class="rail-item is-active" data-step="tracking" data-testid="setup-rail-tracking">
            <span class="rail-badge tech-box-red">01</span>
            <span class="rail-label">${text(WELCOME_WORDS.rail.tracking.toUpperCase())}</span>
          </div>
          <div class="step-connector" aria-hidden="true"></div>
          <div class="rail-item" data-step="projects" data-testid="setup-rail-projects">
            <span class="rail-badge tech-box-red">02</span>
            <span class="rail-label">${text(WELCOME_WORDS.rail.projects.toUpperCase())}</span>
          </div>${diagnostics ? `
          <div class="step-connector" aria-hidden="true"></div>
          <div class="rail-item" data-step="diagnostics" data-testid="setup-rail-diagnostics">
            <span class="rail-badge tech-box-red">03</span>
            <span class="rail-label">${text(WELCOME_TESTER_WORDS.rail.toUpperCase())}</span>
          </div>` : ''}
        </aside>
        <div class="content">
          <fieldset class="step" id="trackingStep" data-setup-step="tracking">
            <legend class="section-title">${text(WELCOME_WORDS.tracking.question)}</legend>
            <div class="option-group" id="autoTrackGroup" role="radiogroup" aria-label="${text(WELCOME_WORDS.tracking.groupName)}" data-next-focus="pickFolders">
              <label class="option">
                <input type="radio" name="autoTrack" value="yes" checked data-testid="auto-track-yes">
                <span class="option-card btn btn-red tech-box-red option-mark">[ ${text(WELCOME_WORDS.tracking.yes)} ]</span>
              </label>
              <label class="option">
                <input type="radio" name="autoTrack" value="no" data-testid="auto-track-no">
                <span class="option-card btn btn-grey tech-box-grey option-mark">[ ${text(WELCOME_WORDS.tracking.no)} ]</span>
              </label>
            </div>
          </fieldset>
          <section class="step projects-step" aria-labelledby="projectsTitle" data-setup-step="projects">
            <div class="step-head">
              <h2 class="section-title" id="projectsTitle">${text(WELCOME_WORDS.projects.heading)}</h2>
              <span class="project-count" id="projectCount" lang="en">${text(WELCOME_ENGLISH.added.replace('{N}', '0'))}</span>
            </div>
            <div class="project-list is-empty tech-box-white" id="projectList" role="list" aria-label="${text(WELCOME_WORDS.projects.listName)}" data-testid="project-list"></div>
            <div class="project-actions">
              <button class="terminal-button tech-box-red" id="pickFolders" type="button" data-testid="add-projects">+ ${text(WELCOME_WORDS.projects.add.toUpperCase())}</button>
              <p class="hint">${WELCOME_WORDS.projects.hint.split('\n').map(text).join('<br>')}</p>
            </div>
          </section>${diagnostics ? `
          <section class="step diagnostics-step" aria-labelledby="diagnosticsTitle" data-setup-step="diagnostics" data-testid="setup-diagnostics">
            <h2 class="section-title" id="diagnosticsTitle">${text(WELCOME_TESTER_WORDS.heading)}</h2>
            ${WELCOME_TESTER_WORDS.text.split('\n\n').map((paragraph) => `<p>${text(paragraph)}</p>`).join('\n            ')}
            <label for="invitedEmail">${text(WELCOME_TESTER_WORDS.emailLabel)}</label>
            <input id="invitedEmail" name="invitedEmail" type="email" autocomplete="email" maxlength="254" spellcheck="false" data-testid="invited-email">
          </section>` : ''}
        </div>
      </div>
      <div class="dashed-divider section-divider" aria-hidden="true">==================================================================================================================================================================================================</div>
      <footer class="content-footer footer-action">
        <div class="message comment-text" id="message" aria-live="polite">/* ${text(WELCOME_WORDS.messages.ready)}</div>
        <button class="terminal-button primary-button tech-box-red" id="saveButton" type="button" data-testid="save-setup">+ ${text(WELCOME_WORDS.buttons.save)} -&gt;</button>
      </footer>
      <div class="dashed-divider section-divider" aria-hidden="true">==================================================================================================================================================================================================</div>
      <footer class="statusline status-bar">
        <span class="normal-mode status-mode tech-box-red" lang="en">${text(WELCOME_ENGLISH.mode)}</span>
        <span class="status-text" id="statusText" aria-live="polite" lang="en">+++ setup: ready +++</span>
        <span class="keyboard-hint status-shortcuts" lang="en">${text(WELCOME_ENGLISH.shortcuts)}</span>
      </footer>
    </div>
  </main>
  <script>${script}</script>
</body>
</html>`;
}