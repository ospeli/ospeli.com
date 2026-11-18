// Stores and supplies: the module's pack (see core/modules.js for the contract).
// SKELETON wired by the module crew lead: the builder replaces everything below the stock
// configuration and may change the lists inside it. Counting, requesting, issuing, receiving,
// transfers, stock-outs, write-offs, levels and item adds are the shared stock commands
// (ospeli_stock_*, core/stock-commands.js): this pack writes none of them again.

export const id = 'stores';
export const PREFIX = 'ospeli_stores_';
export const EVENT_PREFIX = 'stores.';

// Who may do what with ward supplies. Every verb is listed; [] means nobody does it here.
export const STOCK_CATEGORIES = {
  supplies: { name: 'Supplies', roles: {
    count: ['ward-nurse', 'storekeeper', 'supply-manager'], request: ['ward-nurse', 'supply-manager'], issue: ['storekeeper'], receive: ['storekeeper'],
    transfer: ['storekeeper', 'supply-manager'], use: [], writeOff: ['storekeeper', 'supply-manager'], hold: ['supply-manager'], release: ['supply-manager'],
    levels: ['supply-manager'], itemAdd: ['supply-manager'],
  } },
};
// Generic consumables only: no brand, supplier, price or currency.
export const STOCK_ITEMS = [
  { id: 'gloves-m', name: 'Examination gloves, medium', unit: 'box of 100', category: 'supplies', tracer: true },
  { id: 'syringe-5', name: 'Syringe 5 ml', unit: 'box of 100', category: 'supplies', tracer: true },
  { id: 'gauze-swabs', name: 'Gauze swabs', unit: 'pack of 100', category: 'supplies' },
];

export const COMMANDS = [];
