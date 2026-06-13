// Background "check for updates" loop. Git Radar is local-first with no public
// endpoint, so it can't receive GitHub push webhooks — instead it polls `gh`
// on an interval and runs a scan (sync + per-PR summarize) on the sprint that
// is currently live, so new merges arrive already summarized for planning.
//
// Dependencies are injected (store, scan, timers) so it's fully unit-testable
// with no real timers or Electron.

import { isoDate } from './util.js';

export function createPoller({
  store,
  scan,
  emit = () => {},
  now = () => new Date(),
  schedule = setInterval,
  unschedule = clearInterval,
} = {}) {
  let timer = null;
  let polling = false;

  /**
   * The sprint(s) to poll: per repo, any sprint whose window contains today;
   * if none is live (between cycles), fall back to the most recent sprint so a
   * just-ended cycle still picks up late merges.
   */
  function liveSprints() {
    const today = isoDate(now());
    const out = [];
    for (const repo of store.listRepos()) {
      const sprints = store.listSprints(repo.id);
      if (!sprints.length) continue;
      const live = sprints.filter((s) => s.startDate <= today && today <= s.endDate);
      for (const s of live.length ? live : [sprints[sprints.length - 1]]) out.push(s);
    }
    return out;
  }

  /** One pass over the live sprints. Reentrancy-guarded; never throws. */
  async function pollOnce() {
    if (polling) return { skipped: 'in-progress', results: [] };
    polling = true;
    const results = [];
    try {
      for (const sprint of liveSprints()) {
        try {
          const r = await scan(sprint.id);
          const changed = (r.added || 0) + (r.classified || 0) > 0;
          results.push({ sprintId: sprint.id, changed, ...r });
          emit({
            task: 'autopoll',
            sprintId: sprint.id,
            changed,
            done: true,
            message: `Auto-poll · ${sprint.name}: ${r.added || 0} new, ${r.classified || 0} summarized.`,
          });
        } catch (e) {
          results.push({ sprintId: sprint.id, error: e.message });
          emit({ task: 'autopoll', sprintId: sprint.id, done: true, error: true,
            message: `Auto-poll skipped ${sprint.name}: ${e.message}` });
        }
      }
    } finally {
      polling = false;
    }
    return { results };
  }

  /** (Re)configure the interval from settings. Returns the active interval, or null. */
  function apply(settings = {}) {
    stop();
    if (!settings.autoPoll) return null;
    const mins = Math.max(1, Number(settings.autoPollMinutes) || 15);
    timer = schedule(() => { pollOnce().catch(() => {}); }, mins * 60000);
    if (timer && typeof timer.unref === 'function') timer.unref(); // don't keep the process alive
    return mins;
  }

  function stop() {
    if (timer) {
      unschedule(timer);
      timer = null;
    }
  }

  return { pollOnce, apply, stop, liveSprints, isRunning: () => polling };
}
