const SNAPSHOT_FIELDS = ['tag', 'role', 'type', 'name', 'href', 'disabled', 'checked'];

function snapshotMap(snapshot, label) {
  if (!snapshot || !Array.isArray(snapshot.elements)) throw new Error(`${label} snapshot must contain an elements array`);
  const byRef = new Map();
  for (const element of snapshot.elements) {
    const ref = String(element?.ref || '');
    if (!/^e\d+$/.test(ref)) throw new Error(`${label} snapshot contains an invalid Ferrum ref: ${ref || '<empty>'}`);
    if (byRef.has(ref)) throw new Error(`${label} snapshot contains duplicate Ferrum ref ${ref}`);
    byRef.set(ref, element);
  }
  return byRef;
}

function pageValue(snapshot, field) {
  return snapshot?.[field] == null ? null : snapshot[field];
}

export function diffSnapshots(before, after) {
  const beforeByRef = snapshotMap(before, 'Before');
  const afterByRef = snapshotMap(after, 'After');
  const added = [];
  const removed = [];
  const changed = [];
  let unchangedCount = 0;

  for (const current of after.elements) {
    const previous = beforeByRef.get(current.ref);
    if (!previous) {
      added.push(current);
      continue;
    }
    const changes = {};
    for (const field of SNAPSHOT_FIELDS) {
      const beforeValue = previous[field] ?? null;
      const afterValue = current[field] ?? null;
      if (!Object.is(beforeValue, afterValue)) changes[field] = { before: beforeValue, after: afterValue };
    }
    if (Object.keys(changes).length) changed.push({ ref: current.ref, changes });
    else unchangedCount += 1;
  }

  for (const previous of before.elements) {
    if (!afterByRef.has(previous.ref)) removed.push(previous);
  }

  return {
    before: { url: pageValue(before, 'url'), title: pageValue(before, 'title'), count: before.elements.length },
    after: { url: pageValue(after, 'url'), title: pageValue(after, 'title'), count: after.elements.length },
    page: {
      url: { before: pageValue(before, 'url'), after: pageValue(after, 'url') },
      title: { before: pageValue(before, 'title'), after: pageValue(after, 'title') }
    },
    added,
    removed,
    changed,
    unchangedCount
  };
}
