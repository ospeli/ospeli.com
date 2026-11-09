// Hospital model: entity types, roles and validation (foundation section 5.1 and 5.12).
// Plain data only. Every entity is { id, type, name, parentId?, ...attributes }.

export const ENTITY_TYPES = {
  site: { parents: [] },
  building: { parents: ['site'] },
  department: { parents: ['site', 'building'] },
  ward: { parents: ['department', 'building', 'site'] },
  bed: { parents: ['ward'] },
  asset: { parents: ['site', 'building', 'department', 'ward', 'bed'] },
  role: { parents: [] },
  shift: { parents: [] },
};

// The six roles the build month must serve. Measure flows by role, never people.
export const ROLES = [
  { id: 'ward-nurse', name: 'Ward nurse', home: 'beds' },
  { id: 'bed-manager', name: 'Bed manager', home: 'beds' },
  { id: 'estates-tech', name: 'Estates tech', home: 'engineering' },
  { id: 'ae-nic', name: 'A&E nurse in charge', home: 'ae' },
  { id: 'ops-manager', name: 'Ops manager', home: 'dashboard' },
  { id: 'coo', name: 'COO', home: 'dashboard' },
];

export const roleById = (id) => ROLES.find((r) => r.id === id) || null;

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const EVENT_TYPE_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

export function validateEntity(e) {
  const errs = [];
  if (!e || typeof e !== 'object') return ['entity must be an object'];
  if (typeof e.id !== 'string' || !ID_RE.test(e.id)) errs.push('id must be lower-case letters, digits and hyphens');
  if (!ENTITY_TYPES[e.type]) errs.push(`unknown entity type ${e.type}`);
  if (typeof e.name !== 'string' || !e.name.trim()) errs.push('name is required');
  if (e.parentId != null && typeof e.parentId !== 'string') errs.push('parentId must be a string');
  return errs;
}

export function validateEvent(ev) {
  const errs = [];
  if (!ev || typeof ev !== 'object') return ['event must be an object'];
  if (typeof ev.type !== 'string' || !EVENT_TYPE_RE.test(ev.type)) errs.push('type must look like "bed.vacated"');
  if (typeof ev.subject !== 'string' || !ev.subject) errs.push('subject (entity id) is required');
  if (!roleById(ev.actorRole) && ev.actorRole !== 'system') errs.push(`unknown actor role ${ev.actorRole}`);
  if (ev.at != null && Number.isNaN(Date.parse(ev.at))) errs.push('at must be an ISO time stamp');
  return errs;
}
