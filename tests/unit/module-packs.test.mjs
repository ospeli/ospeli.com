// The contract every module's command file (a "pack", core/modules.js) keeps. A module is
// configuration and content on the shared core: this test is what stops one module from reaching
// into another, into the core's names, or past the rules every command follows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MODULE_PACKS } from '../../web/app/core/modules.js';
import { listCommands, commandByName } from '../../web/app/core/commands.js';
import { ROLES } from '../../web/app/core/model.js';
import { generateHospital } from '../../web/app/core/generator.js';
import { validateEvent } from '../../web/app/core/model.js';
import { MODULES } from '../../web/app/modules/registry.js';

const APP = fileURLToPath(new URL('../../web/app/', import.meta.url));
const ROLE_IDS = ROLES.map((r) => r.id);
const END = '2026-11-06T18:00:00.000Z';
const CORE_PREFIXES = ['ospeli_beds_', 'ospeli_kpi_', 'ospeli_agents_', 'ospeli_proposals_', 'ospeli_assets_', 'ospeli_workorders_', 'ospeli_maps_', 'ospeli_walks_', 'ospeli_tasks_'];

test('every module pack has an id, its own command prefix and its own event prefix', () => {
  const ids = new Set(); const prefixes = new Set(); const eventPrefixes = new Set();
  for (const p of MODULE_PACKS) {
    assert.match(p.id, /^[a-z][a-z0-9-]{1,30}$/, 'a module id is lower-case letters, digits and hyphens');
    assert.match(p.PREFIX, /^ospeli_[a-z][a-z0-9]*_$/, `${p.id}: PREFIX looks like ospeli_<module>_`);
    assert.match(p.EVENT_PREFIX, /^[a-z][a-z0-9-]*\.$/, `${p.id}: EVENT_PREFIX looks like "<module>."`);
    assert.ok(!CORE_PREFIXES.includes(p.PREFIX), `${p.id}: ${p.PREFIX} belongs to the core`);
    for (const core of ['bed.', 'patient.', 'ae.', 'asset.', 'workorder.', 'task.', 'role.', 'agent.', 'agents.', 'data.', 'entity.', 'entities.', 'events.', 'walk.', 'map.', 'device.', 'devices.', 'setup.']) {
      assert.notEqual(p.EVENT_PREFIX, core, `${p.id}: ${core}* events belong to the core`);
    }
    for (const [set, v] of [[ids, p.id], [prefixes, p.PREFIX], [eventPrefixes, p.EVENT_PREFIX]]) { assert.ok(!set.has(v), `${v} is used by two modules`); set.add(v); }
    assert.ok(Array.isArray(p.COMMANDS) && p.COMMANDS.length, `${p.id}: COMMANDS is a list`);
    // Its files are where the offline cache and the registry expect them.
    for (const f of ['commands.js', 'view.js', 'style.css']) assert.ok(existsSync(`${APP}modules/${p.id}/${f}`), `${p.id}: modules/${p.id}/${f} exists`);
    assert.ok(MODULES.some((m) => m.id === p.id && typeof m.load === 'function' && [].concat(m.commands || []).includes(p.PREFIX)), `${p.id}: listed in the registry with its page and its command prefix`);
  }
});

test('every module command is named for its module, is in the registry, and follows the command rules', () => {
  for (const p of MODULE_PACKS) {
    for (const c of p.COMMANDS) {
      assert.ok(c.name.startsWith(p.PREFIX), `${c.name}: a command of ${p.id} starts with ${p.PREFIX}`);
      assert.match(c.name, /^ospeli_[a-z0-9]+(_[a-z0-9]+)+$/);
      assert.equal(commandByName(c.name), c, `${c.name} is in the registry`);
      assert.ok(['read', 'write'].includes(c.kind), `${c.name}: kind is read or write`);
      assert.ok(Array.isArray(c.roles) && c.roles.length && c.roles.every((r) => ROLE_IDS.includes(r)), `${c.name}: roles are real roles`);
      assert.equal(c.input?.type, 'object');
      assert.equal(c.input.additionalProperties, false, `${c.name}: input refuses fields it does not know`);
      assert.equal(c.output?.type, 'object');
      assert.equal(typeof c.run, 'function');
      assert.ok(typeof c.summary === 'string' && c.summary.length >= 30, `${c.name}: the summary says what it is for`);
      // A read never needs approval; a write always does when an agent asks (it becomes a proposal).
      assert.equal(c.approval, c.kind === 'write', `${c.name}: approval is true for a write and false for a read`);
      // Every string a caller can send is bounded: an enum, a pattern, a time or a maximum length.
      const unbounded = Object.entries(c.input.properties || {}).filter(([, s]) => s.type === 'string' && !s.enum && !s.pattern && s.format !== 'date-time' && !(s.maxLength > 0));
      assert.deepEqual(unbounded.map(([k]) => k), [], `${c.name}: string inputs are bounded`);
      // Text a person typed is checked for personal details before it is kept, and the answer is marked.
      const typed = Object.entries(c.input.properties || {}).filter(([, s]) => s.type === 'string' && !s.enum && !s.pattern && s.format !== 'date-time');
      if (c.kind === 'write' && typed.length) assert.equal(typeof c.check, 'function', `${c.name}: takes typed text (${typed.map(([k]) => k).join(', ')}), so it needs a check (kit.checkTypedText)`);
      if (c.kind === 'write') assert.equal(typeof c.precheck, 'function', `${c.name}: a write has a precheck, so an agent's proposal is checked before it is queued`);
    }
    // A module that returns typed text marks those reads, so an agent treats the text as data.
    if (p.COMMANDS.some((c) => c.kind === 'write' && typeof c.check === 'function')) {
      assert.ok(p.COMMANDS.some((c) => c.kind === 'read' && c.freeText === true), `${p.id}: reads that return typed text set freeText: true`);
    }
  }
  assert.equal(new Set(listCommands().map((c) => c.name)).size, listCommands().length, 'no command name is used twice');
});

test('a module command file never imports the command layer, the screen code or another module', () => {
  for (const p of MODULE_PACKS) {
    const dir = `${APP}modules/${p.id}/`;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const src = readFileSync(dir + f, 'utf8');
      const imports = [...src.matchAll(/(?:import|from)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const spec of imports) {
        assert.ok(spec.startsWith('./') || spec.startsWith('../../core/') || (f !== 'commands.js' && f !== 'logic.js' && /^\.\.\/(ui|proposals|kpi-tiles)\.js$/.test(spec)),
          `modules/${p.id}/${f} imports ${spec}: a module uses its own files, the core, and (in screen files only) ui.js, proposals.js and kpi-tiles.js`);
        if (f === 'commands.js' || f === 'logic.js') assert.ok(!/core\/commands\.js$/.test(spec), `modules/${p.id}/${f} must not import core/commands.js (use core/kit.js)`);
      }
      if (f === 'commands.js' || f === 'logic.js') assert.ok(!/\b(document|window|localStorage|navigator)\b\s*[.[]/.test(src), `modules/${p.id}/${f} has no screen code: it also runs on a site's own server`);
      // Text is never put on screen as HTML.
      assert.ok(!/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/.test(src), `modules/${p.id}/${f}: never put text on screen as HTML (use h() from ui.js)`);
      assert.ok(!/\beval\s*\(|new Function\s*\(/.test(src), `modules/${p.id}/${f}: no eval`);
    }
    // Its stylesheet only styles its own page.
    const css = readFileSync(`${dir}style.css`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...css.matchAll(/(^|\})\s*([^{}@]+)\{/g)].flatMap((m) => m[2].split(',')).map((x) => x.trim()).filter(Boolean);
    for (const sel of selectors) {
      if (/^(from|to|\d+%)$/.test(sel)) continue; // keyframe steps
      assert.ok(sel.startsWith(`.mod-${p.id}`), `modules/${p.id}/style.css: "${sel}" must start with .mod-${p.id}`);
    }
    assert.ok(!/@import|url\(\s*['"]?https?:/i.test(css), `modules/${p.id}/style.css loads nothing from elsewhere`);
  }
});

test('a module\'s synthetic history is valid, repeatable, inside the window and only its own kinds of event', () => {
  const a = generateHospital({ end: END });
  const b = generateHospital({ end: END });
  assert.deepEqual(a.events, b.events, 'the same seed gives the same events');
  for (const e of a.events) assert.deepEqual(validateEvent(e), [], `${e.type} is a valid event`);
  for (const p of MODULE_PACKS) {
    if (typeof p.seed !== 'function') continue;
    const mine = a.events.filter((e) => e.type.startsWith(p.EVENT_PREFIX));
    assert.ok(mine.length > 0, `${p.id}: the example hospital has some ${p.EVENT_PREFIX}* history`);
    assert.ok(mine.every((e) => e.at <= END), `${p.id}: nothing after the end time`);
    for (const e of mine) assert.ok(ROLE_IDS.includes(e.actorRole) || e.actorRole === 'system', `${p.id}: ${e.type} is by a real role`);
  }
});
