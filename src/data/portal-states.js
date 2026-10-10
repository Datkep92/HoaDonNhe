'use strict';
const { withTransaction } = require('./sqlite');

// Only keys observed in a portal response are authoritative. XML and a missing
// portal field cannot reset an existing status. No invoice amounts/items change.
function applyPortalStates(db, states) {
  const update = db.prepare('UPDATE invoices SET tthai = ? WHERE invoice_key = ? AND COALESCE(tthai, ?) <> ?');
  return withTransaction(db, () => {
    let updated = 0;
    for (const [key, raw] of states) {
      const state = String(raw ?? '').trim();
      if (!key || !/^\d+$/.test(state)) continue;
      updated += Number(update.run(state, String(key), '', state).changes);
    }
    return updated;
  });
}

module.exports = { applyPortalStates };
