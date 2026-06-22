/**
 * Pure, reusable applicability and selected-route helpers for the agent-diff
 * (live browser/large-diff) gate. Extracted so both the gate executor and the
 * Stop task-policy core can reason about applicability without duplicating the
 * trigger semantics. No I/O — safe to import anywhere.
 */
export const TRIGGER_MODES = new Set(['files', 'loc', 'files-or-loc', 'files-and-loc']);

function positive(value) {
  return Number.isFinite(value) && value > 0;
}

/**
 * Whether a path/LOC trigger fires for the given changed-file count and LOC.
 * Mirrors the gate's historical `ruleTriggered` semantics exactly.
 */
export function pathLocApplicable(trigger, fileCount, locTotal) {
  const mode = TRIGGER_MODES.has(trigger?.mode) ? trigger.mode : 'files-or-loc';
  const fileHit = positive(trigger?.minChangedFiles) && fileCount >= trigger.minChangedFiles;
  const locHit = positive(trigger?.minChangedLoc) && locTotal >= trigger.minChangedLoc;
  if (mode === 'files') return fileHit;
  if (mode === 'loc') return locHit;
  if (mode === 'files-and-loc') return fileHit && locHit;
  return fileHit || locHit;
}

/**
 * Limit browser findings to the explicitly selected routes. With no selected
 * routes, all findings pass through (route blocking is strongest when routes
 * are explicit). Findings without a route are never silently dropped.
 */
export function selectedRouteFilter(findings, selectedRoutes, routeOf = (finding) => finding && finding.route) {
  if (!Array.isArray(selectedRoutes) || !selectedRoutes.length) return findings || [];
  const set = new Set(selectedRoutes.map((route) => String(route)));
  return (findings || []).filter((finding) => {
    const route = routeOf(finding);
    return route == null || set.has(String(route));
  });
}
