// The module kit: what a module's command file may use from the core.
//
// A module lives in web/app/modules/<id>/ and is configuration and content on the shared core.
// Its commands.js imports from this file (and from pure core files such as tasks.js or
// processmap.js), never from core/commands.js: the command layer imports the modules, so the
// other direction would be a loop.
//
// The contract a module's commands.js follows is checked by tests/unit/module-packs.test.mjs.

import { ROLES } from './model.js';
import { personalDetailIn, personNameIn, possibleNameIn, nameQuestion } from './processmap.js';

export class CommandError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'CommandError';
    this.code = code; // invalid-input | unknown-command | forbidden | not-found | conflict | agents-off
    this.detail = detail;
  }
}

export const ALL_ROLES = ROLES.map((r) => r.id);
export const ID = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$', maxLength: 64 };
// True when x has an id's shape (the ID schema above). Readers of module events use it so a
// sentence in an id field (an edited import, #138) is never kept as a place, asset or vehicle.
const ID_RE = new RegExp(ID.pattern);
export const isId = (x) => typeof x === 'string' && x.length <= ID.maxLength && ID_RE.test(x);
export const TIME = { type: 'string', format: 'date-time', maxLength: 40 };
export const SYNTHETIC = { type: 'boolean', description: 'True while the data on this device is synthetic.' };

// List reads never dump a whole table (tool-design rule, issue #39): each takes a limit, and says
// how many there are in all and whether the answer was cut short. Counts are worked out before the cut.
export const LIMIT = (def, max, what) => ({ type: 'integer', minimum: 1, maximum: max, description: `At most this many ${what}. Default ${def}, ${max} at most. "total" and "truncated" in the answer say if there are more.` });
export const TOTAL = { type: 'integer', minimum: 0, description: 'How many there are in all, before the limit.' };
export const TRUNCATED = { type: 'boolean', description: 'True when the limit cut the list short. Narrow the filters or raise the limit.' };
export const FORMAT = (short, detailed) => ({ type: 'string', enum: ['short', 'detailed'], description: `short: ${short}. detailed (default): ${detailed}.` });
export const page = (list, limit, def) => ({ items: list.slice(0, limit ?? def), total: list.length, truncated: list.length > (limit ?? def) });
export const idsHint = (list, n = 8) => list.slice(0, n).map((x) => x.id).join(', ') + (list.length > n ? ', …' : '');

// What every write answers with: done for a person, proposed for an agent.
export const WRITE_STATUS = { type: 'string', enum: ['done', 'proposed'] };
export const PROPOSAL_OUT = { type: 'object', description: 'When an agent asked: the proposal waiting for a person.' };
export const EVENT_SEQS = { type: 'array', items: { type: 'integer' }, description: 'Sequence numbers of the events written.' };

// Text a person typed (a short note). Ospeli holds no personal details: a name with a title, a
// phone, record or ID number, an email address or a date of birth is refused, and so is text
// that reads as a person's name. A name with no title cannot be told from ordinary words, so the
// command asks once: the caller sends the same input again with notAName: true.
// `fields` are the input keys to read. Use it as the command's `check` and call it again in run.
export const NOT_A_NAME = { type: 'boolean', description: 'Send true only after the command asked whether the text holds a person\'s name and it does not. Never use it to keep a real name.' };
export function checkTypedText(input, fields, { advice = 'Describe what happened and where; never who. Ospeli holds no personal details.' } = {}) {
  for (const k of fields) {
    if (input[k] == null) continue;
    if (typeof input[k] !== 'string' || !input[k].trim()) throw new CommandError('invalid-input', `${k} cannot be empty.`);
    const what = personalDetailIn(input[k]);
    if (what) throw new CommandError('invalid-input', `${k} looks like it holds ${what}. ${advice}`);
    if (personNameIn(input[k])) throw new CommandError('invalid-input', `${k} looks like it names a person. ${advice}`);
    const maybe = input.notAName === true ? null : possibleNameIn(input[k]);
    if (maybe) throw new CommandError('invalid-input', nameQuestion(k, maybe), { confirm: 'notAName', field: k, looksLike: maybe });
  }
}

// Places a module may point at: a site, building, department, ward or bed in the hospital model.
export const PLACE_TYPES = ['site', 'building', 'department', 'ward', 'bed'];
export async function placeOrNull(core, id) {
  const e = id ? await core.getEntity(id) : null;
  return e && PLACE_TYPES.includes(e.type) ? e : null;
}
// The ward a place is, or sits in (a bed's ward). null for a department, building or site.
export async function wardOfPlace(core, id) {
  const e = await placeOrNull(core, id);
  return e?.type === 'ward' ? e.id : e?.type === 'bed' ? e.parentId : null;
}

export const isSynthetic = async (core) => (await core.getMeta('synthetic', false)) === true;

export const MIN = 60e3;
export const HOUR = 3600e3;
export const DAY = 864e5;
export const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// A moment a caller typed, in the one form stored times use (UTC, milliseconds), so that
// "13:00-04:00" and "17:00Z" compare as the same moment. Stored times are compared as text.
export const sameMoment = (x) => { const t = typeof x === 'string' ? Date.parse(x) : NaN; return Number.isNaN(t) ? (x || null) : new Date(t).toISOString(); };
