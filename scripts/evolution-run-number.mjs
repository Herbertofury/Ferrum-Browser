function positiveSafeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function lastNumericToken(value) {
  const matches = String(value ?? '').match(/\d+/gu) ?? [];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const number = positiveSafeInteger(matches[index]);
    if (number !== null) return number;
  }
  return null;
}

export function evolutionRunNumber(record = {}, filename = '') {
  const explicit = positiveSafeInteger(record.run);
  if (explicit !== null) return explicit;

  const runId = lastNumericToken(record.runId);
  if (runId !== null) return runId;

  return lastNumericToken(filename) ?? 0;
}
