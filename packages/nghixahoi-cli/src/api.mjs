import express from 'express';
import {MAX_EVENT_STREAMS, requireDashboardOrigin, requireDashboardRead, requireDashboardWrite, requireLoopbackHost} from './api-access.mjs';
import {claimBundleFromState} from './claim-bundle.mjs';
import {corsMiddleware} from './cors.mjs';
import {renderCompanionWindow} from './companion-window.mjs';
import {cycleReceiptKey, readCycleReceipt} from './cycle-receipt.mjs';
import {describeOutcome, diagnosticsStatus, sendQueued} from './diagnostics.mjs';
import {INSTALL_ID_DISPLAY_PATH, InstallIdError, readInstallId} from './install-id.mjs';
import {CLI_GLOBAL_COMMAND, CYCLE_RECEIPT_PUBLIC_KEY, STATE_DISPLAY_PATH} from './integration-spec.mjs';
import {MilestoneRecordError} from './milestones-reached.mjs';
import {buildSummary, startNextCycle} from './runtime.mjs';
import {loadState, StateFileError, StateLockError} from './store.mjs';

const projectLevelGone = (_req, res) => {
  res.status(410).json({error: 'Project-level metadata is no longer exposed'});
};

// The route that recorded a 10–30 % break code as shown, in state.json, gone with the codes on 2026-10-01 (the operator's
// decision 6; docs/reward-rules.md §7): each milestone reached shows its message on the dashboard instead. It records
// nothing for anyone; a dashboard from before, which still sends it, reads why in fixed words.
const redeemGone = (_req, res) => {
  res.status(410).json({error: 'Break codes are no longer shown or recorded: each milestone reached shows its message on the dashboard.'});
};

// What POST /api/claim/receipt says when it changes nothing (docs/security.md, "The cycle receipt"): fixed words, numbers and
// the times the record holds, never anything of the receipt but its cycle, and "Nothing changed." last, which is true of each.
const NOTHING_CHANGED = 'Nothing changed.';
const RECEIPT_WORDS = {
  'no-key': `This build of Kit=Code takes no receipts: only a build for a campaign with a claim server does. ${NOTHING_CHANGED}`,
  unreadable: `This is not a receipt Kit=Code can read. ${NOTHING_CHANGED}`,
  signature: `This receipt was not signed by Kit=Code's claim server, so Kit=Code did not take it. ${NOTHING_CHANGED}`,
  'install-id': `This receipt is for another Kit=Code install than the one on this computer. ${NOTHING_CHANGED}`,
  used: (cycle, at) => `This receipt began cycle ${cycle} on this computer already, at ${at}. ${NOTHING_CHANGED}`,
  behind: (cycle, current) => `This receipt is for cycle ${cycle}, and Kit=Code on this computer is in cycle ${current} already. ${NOTHING_CHANGED}`,
  // Until 2026-10-22's phase 3 a receipt of a cycle ahead was refused, `ahead`; since then it begins the cycle after it, as the
  // claim backend counts (milestones-reached.mjs, beginNextCycle).
};

// `diagnostics` is the tracker's send loop (src/diagnostics.mjs, startDiagnosticsLoop), for Send logs now.
export function createServer(runtime, version, {diagnostics = null} = {}) {
  const app = express();
  let openEventStreams = 0;

  app.disable('x-powered-by');
  // In this order: a foreign Host is refused before anything else; CORS headers come next, so the
  // dashboard can read what follows, and preflights end there; then a read from a page elsewhere is
  // refused, and writes are held to the dashboard's own requests. Every refusal is readable by any
  // page, and says only fixed words (api-access.mjs).
  app.use(requireLoopbackHost);
  app.use(corsMiddleware);
  app.use(requireDashboardRead);
  app.use(requireDashboardWrite);
  app.use(express.json());

  // `status` says the API answers, as it always has: the dashboard and older CLIs look for 'ok'.
  // `tracking` says how the tracker is doing, `ok` or `degraded`, and `problems` says what is wrong,
  // by code. `pid` lets nghixahoi track tell this tracker from a process that took its pid later.
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      app: 'nghixahoi',
      version,
      pid: process.pid,
      ...(runtime.status?.() ?? {tracking: 'ok', problems: []}),
    });
  });

  app.get('/api/summary', (_req, res) => {
    res.json(buildSummary(runtime));
  });

  app.get('/companion', (_req, res) => {
    res.type('html').send(renderCompanionWindow());
  });

  app.get('/api/projects', (_req, res) => {
    res.json(buildSummary(runtime).global);
  });

  app.post('/api/reward/redeem', redeemGone);

  // The claim bundle (docs/backend.md, "The contract"): totals only, from state.json as it is on disk,
  // which this reads and never writes. Only the dashboard's allow-listed origins get it, where
  // /api/summary also answers a request with no Origin. The tracker sends it nowhere: the dashboard
  // carries it on, in a later phase. Its errors name no local path, as none of the API's do.
  app.get('/api/claim/bundle', requireDashboardOrigin, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    let installId;
    let state;

    try {
      installId = readInstallId();
      state = loadState();
    } catch (error) {
      if (error instanceof InstallIdError) {
        res.status(500).json({error: `Kit=Code cannot read its install id, ${INSTALL_ID_DISPLAY_PATH}, and has left it as it is.`});
        return;
      }

      if (error instanceof StateFileError) {
        res.status(500).json({error: `Kit=Code cannot read ${STATE_DISPLAY_PATH}.`});
        return;
      }

      throw error;
    }

    if (installId === null) {
      res.status(503).json({error: `Kit=Code has no install id yet: the tracker makes one as it starts. Run \`${CLI_GLOBAL_COMMAND} untrack\`, then \`${CLI_GLOBAL_COMMAND} track\`.`});
      return;
    }

    try {
      res.json(claimBundleFromState(state, {installId, cliVersion: version, createdAt: new Date().toISOString()}));
    } catch (error) {
      if (!(error instanceof MilestoneRecordError)) {
        throw error;
      }

      res.status(500).json({error: `The record of when each milestone was reached, in ${STATE_DISPLAY_PATH}, is not one Kit=Code writes, and has been left as it is.`});
    }
  });

  // A cycle receipt (src/cycle-receipt.mjs; docs/backend.md, "The cycle receipt"; the plan of 2026-10-21, decision 1): the
  // dashboard posts it once the claim backend's pages hand it back, after a voucher was issued, and the tracker begins the
  // next cycle, whose milestones all count fresh from now (runtime.mjs, startNextCycle). A write, so it passes every write's
  // guards first, a loopback Host, an allow-listed Origin and a JSON body (api-access.mjs); then it must be signed with the
  // claim backend's key, which this build carries, name this install's id, and be the receipt of the cycle this install is in:
  // anything else is refused in plain words and changes nothing. The signature is checked here alone, never by the prompt
  // hook, which reads the record's cycle as it reads the rest (hard rule 7).
  app.post('/api/claim/receipt', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const refuse = (status, reason, error, extra = {}) => res.status(status).json({error, reason, ...extra});
    const text = req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body) && typeof req.body.receipt === 'string' ? req.body.receipt : null;
    const key = cycleReceiptKey(CYCLE_RECEIPT_PUBLIC_KEY);

    if (key === null) {
      refuse(503, 'no-key', RECEIPT_WORDS['no-key']);
      return;
    }

    if (text === null) {
      refuse(400, 'unreadable', `Send the receipt as {"receipt": "…"}. ${NOTHING_CHANGED}`);
      return;
    }

    const read = readCycleReceipt(text, key);

    if (!read.ok) {
      refuse(422, read.problem, RECEIPT_WORDS[read.problem]);
      return;
    }

    let installId;

    try {
      installId = readInstallId();
    } catch (error) {
      if (error instanceof InstallIdError) {
        refuse(500, 'install-id-unreadable', `Kit=Code cannot read its install id, ${INSTALL_ID_DISPLAY_PATH}, and has left it as it is. ${NOTHING_CHANGED}`);
        return;
      }

      throw error;
    }

    if (installId === null) {
      refuse(503, 'no-install-id', `Kit=Code has no install id yet: the tracker makes one as it starts. Run \`${CLI_GLOBAL_COMMAND} untrack\`, then \`${CLI_GLOBAL_COMMAND} track\`. ${NOTHING_CHANGED}`);
      return;
    }

    if (read.receipt.installId !== installId) {
      refuse(422, 'install-id', RECEIPT_WORDS['install-id']);
      return;
    }

    let outcome;

    try {
      outcome = startNextCycle(runtime, read.receipt);
    } catch (error) {
      if (error instanceof StateLockError) {
        res.setHeader('Retry-After', '2');
        refuse(503, 'busy', `Kit=Code's progress file is busy: try again in a moment. ${NOTHING_CHANGED}`);
        return;
      }

      if (error instanceof StateFileError) {
        refuse(500, 'state-unreadable', `Kit=Code cannot read ${STATE_DISPLAY_PATH}. ${NOTHING_CHANGED}`);
        return;
      }

      throw error;
    }

    switch (outcome.outcome) {
      case 'started':
        res.json({cycle: outcome.cycle, startedAt: outcome.startedAt});
        return;
      case 'used':
        refuse(409, 'used', RECEIPT_WORDS.used(outcome.cycle, outcome.startedAt), {cycle: outcome.cycle});
        return;
      case 'cycle':
        refuse(409, 'behind', RECEIPT_WORDS.behind(read.receipt.cycle, outcome.current), {cycle: outcome.current});
        return;
      default:
        refuse(500, 'record-damaged', `The record of when each milestone was reached, in ${STATE_DISPLAY_PATH}, is not one Kit=Code writes, and has been left as it is. ${NOTHING_CHANGED}`);
    }
  });

  // A tester build's diagnostics, for the staging dashboard (docs/security.md, "Tester diagnostics"): whether this tracker
  // sends them, its install id, which the dashboard links its own events by, what waits, and the last send. Only to an
  // allow-listed Origin, as the claim bundle, which holds the same install id; never the events, or the invited email.
  app.get('/api/diagnostics', requireDashboardOrigin, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const {invitedEmail, ...status} = diagnosticsStatus();
    res.json(invitedEmail === undefined ? status : {...status, emailGiven: invitedEmail !== null});
  });

  // Send logs now: the dashboard's button. A write, so it passes every write's guards first: a loopback Host, an allow-listed
  // Origin and a JSON body (api-access.mjs). It sends what waits, past any backoff, and answers with exactly what the
  // server confirmed, or why nothing was sent, in plain words; in a build that sends nothing, that it sends nothing.
  app.post('/api/diagnostics/send', (_req, res, next) => {
    (diagnostics ? diagnostics.sendNow() : sendQueued({timeoutMs: 10_000, maxBatches: 5, manual: true, source: 'tracker'})).then((result) => {
      res.setHeader('Cache-Control', 'no-store');
      res.json({...result, words: describeOutcome(result)});
    }, next);
  });

  app.get('/api/projects/:id/commits', projectLevelGone);
  app.post('/api/projects/:id/start', projectLevelGone);
  app.post('/api/projects/:id/stop', projectLevelGone);
  app.post('/api/projects/selection', projectLevelGone);

  // Each open stream costs a summary every second, so their number is capped.
  app.get('/api/events', (_req, res) => {
    if (openEventStreams >= MAX_EVENT_STREAMS) {
      res.setHeader('Retry-After', '5');
      res.status(503).json({error: `Kit=Code serves at most ${MAX_EVENT_STREAMS} event streams at once.`});
      return;
    }

    openEventStreams += 1;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = () => {
      res.write('event: summary\n');
      res.write(`data: ${JSON.stringify(buildSummary(runtime))}\n\n`);
    };
    const interval = setInterval(send, 1000);

    send();
    // The response closes when the client goes, whatever the request stream does.
    res.once('close', () => {
      clearInterval(interval);
      openEventStreams -= 1;
    });
  });

  // A body that is not valid JSON, and anything thrown, gets a short answer: Express's own error page
  // carries the stack trace, local paths included.
  app.use((error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
    res.status(status).json({error: status === 500 ? 'Kit=Code could not answer that request.' : 'Kit=Code could not read that request.'});
  });

  return app;
}
