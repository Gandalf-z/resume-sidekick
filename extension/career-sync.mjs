export function createCareerSyncPayload(items, version = '1.3.0', exportedAt = new Date().toISOString()) {
  if (!Array.isArray(items)) throw new TypeError('resume items must be an array');
  if (items.length > 500) throw new RangeError('at most 500 resume items can be synchronized');
  return {
    resumeSidecarItems: items,
    version: String(version || 'unknown'),
    exportedAt: String(exportedAt || new Date().toISOString())
  };
}
