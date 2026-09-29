// Atomic balance helpers. A read-then-write balance check lets two requests
// sent at the same moment both pass the check and both spend the same funds;
// these do the check and the write in one conditional UPDATE instead.

// Sub-cent tolerance for Float storage drift (e.g. 355.529999999999996 for a
// displayed "355.53"), matching the checks the routes already used.
const EPSILON = 0.005;

// Decrements user[field] by amt only if the balance covers it. Returns true
// when the debit happened. `db` is prisma or an interactive-transaction client.
async function debit(db, userId, field, amt) {
  const r = await db.user.updateMany({
    where: { id: userId, [field]: { gte: amt - EPSILON } },
    data: { [field]: { decrement: amt } }
  });
  return r.count === 1;
}

// Moves a record from one status to another only if it still has the
// expected status. Returns true for exactly one caller, so double-clicks and
// concurrent requests cannot process the same record twice.
async function claim(delegate, id, field, from, to) {
  const r = await delegate.updateMany({ where: { id, [field]: from }, data: { [field]: to } });
  return r.count === 1;
}

class InsufficientBalance extends Error {}

module.exports = { debit, claim, InsufficientBalance, EPSILON };
