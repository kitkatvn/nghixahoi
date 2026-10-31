import {hookStatus, installHook, replaceLegacyHook, uninstallHook} from './hook-installers.mjs';
import {AGENT_SPECS} from './integration-spec.mjs';
import {removeLegacySkill} from './legacy.mjs';
import {installRunner, runnerStatus} from './runner-installer.mjs';
import {installSkill, skillStatus, uninstallSkill} from './skill-installer.mjs';

// `on` for one agent moves an earlier Kit=Code off every agent (src/legacy.mjs): its entry in the other agent's config is replaced
// by this one's, where there is one, so that no hook runs the earlier package; and its skills are taken out, but for an agent whose
// config could not be written. None of it is said: the user is never told an earlier name.
export function installIntegration(source) {
  const runner = installRunner();
  const hook = installHook(source);
  const skill = installSkill(source);
  const others = Object.keys(AGENT_SPECS).filter((other) => other !== source).map((other) => ({source: other, hook: replaceLegacyHook(other)}));

  if (hook.action !== 'refused') {
    removeLegacySkill(source);
  }

  for (const other of others) {
    if (other.hook.action !== 'refused') {
      removeLegacySkill(other.source);
    }
  }

  return {
    runner,
    hook,
    skill,
  };
}

export function uninstallIntegration(source) {
  const hook = uninstallHook(source);

  if (hook.action !== 'refused') {
    removeLegacySkill(source);
  }

  return {
    hook,
    skill: uninstallSkill(source),
  };
}

export function integrationStatus(source) {
  return {
    runner: runnerStatus(),
    hook: hookStatus(source),
    skill: skillStatus(source),
  };
}
