export const TRUNCATION_MARKER = '[... omitted additional context because the output cap was reached ...]';

function normalizePath(value) {
  return (value || '').toString().replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

function detectionTokens(project) {
  const source = Array.isArray(project.detection)
    ? project.detection
    : [project.slug, ...(Array.isArray(project.aliases) ? project.aliases : [])];
  return source
    .map((token) => normalizePath(token).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
}

function pathSegments(path) {
  return normalizePath(path).split('/').filter(Boolean);
}

function hasSegmentSequence(segments, token) {
  const tokenSegments = token.split('/').filter(Boolean);
  if (!tokenSegments.length || tokenSegments.length > segments.length) return false;
  for (let start = 0; start <= segments.length - tokenSegments.length; start += 1) {
    if (tokenSegments.every((segment, offset) => segments[start + offset] === segment)) return true;
  }
  return false;
}

export function projectFromCwd(cwd, projects) {
  const normalizedCwd = normalizePath(cwd);
  if (!normalizedCwd || !Array.isArray(projects)) return '';

  for (const project of projects) {
    const repoPath = normalizePath(project && project.repoPath);
    if (repoPath && (normalizedCwd === repoPath || normalizedCwd.startsWith(`${repoPath}/`))) {
      return project.slug || '';
    }
  }

  const segments = pathSegments(normalizedCwd);
  for (const project of projects) {
    for (const token of detectionTokens(project || {})) {
      if (hasSegmentSequence(segments, token)) return project.slug || '';
    }
  }
  return '';
}

function boundedCap(capChars) {
  const cap = Number(capChars);
  if (!Number.isFinite(cap)) return Infinity;
  return Math.max(0, Math.floor(cap));
}

function resolveBudget(value) {
  const cap = Number(value);
  if (!Number.isFinite(cap)) return Infinity;
  return Math.max(0, Math.floor(cap));
}

function itemValue(item, key) {
  if (typeof item === 'string') return item.trim();
  if (item && typeof item === 'object') return (item[key] || '').toString().trim();
  return '';
}

function boundedBlock(text, cap) {
  const value = (text || '').toString().trim();
  if (!value) return '';
  const limit = resolveBudget(cap);
  return value.length > limit ? withMarkerWithinCap(value, limit) : value;
}

function section(label, items, cap = Infinity) {
  const lines = items.filter(Boolean);
  if (!label || !lines.length) return '';
  return boundedBlock(`${label}\n- ${lines.join('\n- ')}`, cap);
}

function withMarkerWithinCap(output, cap) {
  if (cap <= 0) return '';
  if (!Number.isFinite(cap)) return output ? `${output}\n\n${TRUNCATION_MARKER}` : TRUNCATION_MARKER;
  if (TRUNCATION_MARKER.length > cap) return TRUNCATION_MARKER.slice(0, cap);
  if (!output) return TRUNCATION_MARKER;

  const markerBlockLength = 2 + TRUNCATION_MARKER.length;
  if (markerBlockLength > cap) return TRUNCATION_MARKER;

  const maxOutputLength = cap - markerBlockLength;
  const boundedOutput = output.length > maxOutputLength
    ? output.slice(0, maxOutputLength).trimEnd()
    : output;
  return boundedOutput ? `${boundedOutput}\n\n${TRUNCATION_MARKER}` : TRUNCATION_MARKER;
}

export function composeOutput(rules, suggested, memories, labels, capChars, budgets = {}, diagnostics = []) {
  const cap = boundedCap(capChars);
  const outputLabels = labels || {};
  const base = boundedBlock(rules, budgets.protocolChars);
  if (base.length > cap) return withMarkerWithinCap(base, cap);

  const sections = [
    section(outputLabels.diagnostics, diagnostics, budgets.diagnosticsChars),
    section(outputLabels.skills, (suggested || []).map((item) => itemValue(item, 'name')), budgets.skillsChars),
    section(outputLabels.memory, (memories || []).map((item) => itemValue(item, 'text')), budgets.memoryChars)
  ].filter(Boolean);

  let output = base;
  for (const currentSection of sections) {
    const candidate = output ? `${output}\n\n${currentSection}` : currentSection;
    if (candidate.length <= cap) {
      output = candidate;
      continue;
    }
    return withMarkerWithinCap(output, cap);
  }
  return output;
}
