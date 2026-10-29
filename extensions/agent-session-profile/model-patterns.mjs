// Resolve configured enabled-model globs through the public registry facade.
// Escape regex metacharacters so configuration is data, not executable regex.
export function scopedModelRefs(patterns, models) {
  const matchers = patterns.map(pattern => {
    const base = pattern.replace(/:(?:off|minimal|low|medium|high|xhigh)$/, '');
    const source = [...base].map(char => char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
    return new RegExp(`^${source}$`, 'i');
  });
  return [...new Set(models.flatMap(model => {
    const ref = `${model.provider}/${model.id}`;
    return matchers.some(matcher => matcher.test(ref) || matcher.test(model.id)) ? [ref] : [];
  }))].sort((a,b) => a.localeCompare(b));
}
