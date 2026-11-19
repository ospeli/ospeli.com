// The modules built on the shared core. Each module's commands.js is a "pack": plain data and
// pure functions, no screen code, so the same file runs in the browser, in tests and on a site's
// own server. The command layer, the task object and the synthetic generator read this list.
//
// A pack exports (tests/unit/module-packs.test.mjs checks every pack against this):
//   id           the module's id, the same as its folder and its page address (#/<id>)
//   PREFIX       every command name starts with it, e.g. 'ospeli_support_'
//   EVENT_PREFIX every event type the module writes starts with it, e.g. 'support.'
//                (a module that uses the shared task object writes task.* through the task
//                commands only, never by itself)
//   COMMANDS     [command]: name, summary, kind, roles, approval, input, output, run, example
//   TASK_TEAMS, TASK_KINDS   optional: its kinds of task for the shared task object
//   STOCK_CATEGORIES, STOCK_ITEMS   optional: its category of stock (with the roles for each verb)
//                and its example items, for the shared stock item (core/stock.js)
//   SESSION_TYPES, SLOT_TYPES   optional: its types of session (timed slots, or a capacity with a
//                visit order; the roles that run, plan, book and mark steps) and of slot, for the
//                shared appointment or slot object (core/slots.js); also NO_SHOW_GRACE_MINUTES and
//                SLOT_REASONS (extra reasons to pick from). The module writes no booking command.
//   KPIS         optional: [{ id, name, unit, definition, source, ... }] with a calculation each
//   seed         optional: (ctx) => [{ t, type, subject, actorRole, data }] synthetic events for
//                the example hospital; ctx = { r, startMs, endMs, days, entities, events }
//
// Only the module crew lead edits this file: one import and one list entry per module.

import * as feedback from '../modules/feedback/commands.js';
import * as support from '../modules/support/commands.js';
import * as stores from '../modules/stores/commands.js';
import * as facilities from '../modules/facilities/commands.js';

export const MODULE_PACKS = [feedback, support, stores, facilities];

export const MODULE_COMMANDS = MODULE_PACKS.flatMap((p) => p.COMMANDS || []);
export const packById = (id) => MODULE_PACKS.find((p) => p.id === id) || null;
