// Issue #44 (last two points): (a) the A3 long-stay measure names a checkable source for its
// 21-day threshold, and still says the number is an editable default; (b) the B4 stock-out rate
// and order cycle time name the related WHO harmonized PSM indicators (WHO 2011,
// ISBN 978 92 4 150081 4) by their own words, and say they are counted differently, so the page
// never claims the WHO definition for a measure that is not it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const AREAS = JSON.parse(read('web/areas/areas.json'));
const kpi = (area, name) => AREAS.find((a) => a.id === area).kpis.find((k) => k.name === name);
const unquote = (s) => s.replace(/&quot;|&#x27;|&#39;/g, (m) => (m === '&quot;' ? '"' : "'")).replace(/&amp;/g, '&');

test('#44 (a): the 21-day long-stay threshold names where it is used, and stays an editable default', () => {
  const { source } = kpi('A3', 'Long-stay patients');
  assert.match(source, /21 days: editable default/);
  assert.match(source, /“long stays \(21 days or more\)”/, 'quotes the source\'s own words');
  assert.match(source, /Reducing length of stay/, 'names the page');
  assert.match(source, /not (a )?clinical standards?/, 'says it is a review convention, not a clinical standard');
  assert.ok(unquote(read('web/areas/beds-and-patient-flow/index.html')).includes('long stays (21 days or more)'), 'the built page carries it');
});

test('#44 (b): B4 names the WHO harmonized PSM indicators it relates to, word for word, and how it differs', () => {
  const WHO = 'WHO 2011, ISBN 978 92 4 150081 4';
  const so = kpi('B4', 'Stock-out rate on critical items').source;
  assert.match(so, /^Editable default/);
  assert.ok(so.includes('indicator 12, "Percentage of treatment sites that had a stock-out of one or more required medicines during a defined period"'), so);
  assert.ok(so.includes(WHO));
  assert.match(so, /counts sites, not item-days/);
  const oc = kpi('B4', 'Order cycle time').source;
  assert.match(oc, /^Editable default/);
  assert.ok(oc.includes('6A, "Percentage of orders delivered in full and on time (as stated in the procurement agreement) per supplier in a defined period"'), oc);
  assert.ok(oc.includes('8, "Percentage of treatment sites that received all orders in full and on time during a defined period"'), oc);
  assert.ok(oc.includes(WHO));
  assert.match(oc, /not days/);
  const page = unquote(read('web/areas/supply-chain-stores/index.html'));
  assert.ok(page.includes('Percentage of treatment sites that had a stock-out of one or more required medicines during a defined period'), 'the built page carries it');
  assert.ok(page.includes('Percentage of orders delivered in full and on time'), 'the built page carries it');
});
