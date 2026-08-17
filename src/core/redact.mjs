const REDACTED = '[REDACTED]';
const TEMPLATE = /\$\{(?:VAR|ENV):[A-Za-z_][A-Za-z0-9_]*\}/;
const URL_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s"'<>]+/gi;
const BEARER_IN_TEXT = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const SENSITIVE_VARIABLE_PART = /(?:^|_)(?:AUTH|AUTHORIZATION|BEARER|CLIENT_SECRET|CREDENTIAL|CREDENTIALS|PASSWORD|PASSWD|PAT|PRIVATE_KEY|SECRET|TOKEN|ACCESS_KEY|API_KEY|USERNAME|USER_NAME)(?:_|$)/i;

const SENSITIVE_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'cookies',
  'setcookie',
  'password',
  'passwd',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'accesskey',
  'apikey',
  'clientsecret',
  'privatekey',
  'credential',
  'credentials',
  'username'
]);

const SENSITIVE_SUFFIXES = [
  'authorization',
  'password',
  'username',
  'accesstoken',
  'refreshtoken',
  'accesskey',
  'apikey',
  'clientsecret',
  'privatekey'
];

function compactKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveKey(key) {
  const compact = compactKey(key);
  return SENSITIVE_KEYS.has(compact) || SENSITIVE_SUFFIXES.some(suffix => compact.endsWith(suffix));
}

export function isSensitiveVariableName(name) {
  const normalized = String(name || '').replace(/[-.]/g, '_');
  return isSensitiveKey(normalized) || SENSITIVE_VARIABLE_PART.test(normalized);
}

function isTemplate(value) {
  return typeof value === 'string' && TEMPLATE.test(value);
}

function redactSingleUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return value;

  let changed = false;
  if (parsed.username || parsed.password) {
    parsed.username = REDACTED;
    parsed.password = '';
    changed = true;
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (isSensitiveKey(key)) {
      parsed.searchParams.set(key, REDACTED);
      changed = true;
    }
  }
  return changed ? parsed.toString() : value;
}

export function redactUrl(value) {
  if (typeof value !== 'string' || isTemplate(value)) return value;
  return redactSingleUrl(value);
}

function redactString(value, redactValues = []) {
  if (isTemplate(value)) return value;
  let safe = value;
  for (const secret of redactValues) {
    const text = String(secret || '');
    if (text && safe.includes(text)) safe = safe.split(text).join(REDACTED);
  }
  const wholeUrl = redactSingleUrl(safe);
  if (wholeUrl !== safe) return wholeUrl;
  return safe
    .replace(URL_IN_TEXT, match => redactSingleUrl(match))
    .replace(BEARER_IN_TEXT, `Bearer ${REDACTED}`);
}

export function redactSensitive(value, key = null, redactValues = []) {
  if (key != null && isSensitiveKey(key)) {
    if (isTemplate(value)) return value;
    return REDACTED;
  }
  if (typeof value === 'string') return redactString(value, redactValues);
  if (Array.isArray(value)) return value.map(item => redactSensitive(item, null, redactValues));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactSensitive(child, childKey, redactValues)]));
}

function stripInternal(value) {
  if (Array.isArray(value)) return value.map(stripInternal);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.startsWith('__'))
      .map(([key, child]) => [key, stripInternal(child)])
  );
}

export function specForEvidence(spec) {
  const source = spec?.__sourceSpec || spec;
  return redactSensitive(stripInternal(source));
}

export { REDACTED };
