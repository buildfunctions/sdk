export function waitWithAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve(undefined);
    }, ms);

    const onAbort = () => {
      clearTimeout(timeoutId);
      cleanup();
      reject(new Error("aborted"));
    };

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createMapAdapter(initialEntries = []) {
  const map = new Map(initialEntries);
  const adapter = {
    get: (key) => map.get(key),
    set: (key, value) => {
      map.set(key, value);
    },
    delete: (key) => {
      map.delete(key);
    },
    keys: () => map.keys(),
  };

  return { map, adapter };
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertOk(value, message) {
  if (!value) {
    throw new Error(message || `Expected truthy value, got ${JSON.stringify(value)}`);
  }
}

export function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(message || `Expected deep equal:\n  actual:   ${a}\n  expected: ${b}`);
  }
}

export async function assertRejects(fn, validator) {
  let threw = false;
  try {
    await fn();
  } catch (error) {
    threw = true;
    if (validator) {
      const result = validator(error);
      if (result === false) throw new Error("Rejection validator returned false");
    }
  }
  if (!threw) throw new Error("Expected function to throw");
}

export function matchesFields(error, expected = {}) {
  if (!error || typeof error !== "object") {
    return false;
  }

  if (expected.code && error.code !== expected.code) {
    return false;
  }

  const status = typeof error.statusCode === "number" ? error.statusCode : undefined;
  if (typeof expected.statusCode === "number" && status !== expected.statusCode) {
    return false;
  }

  if (expected.messageIncludes) {
    const message = typeof error.message === "string" ? error.message : String(error.message ?? "");
    if (!new RegExp(expected.messageIncludes, "i").test(message)) {
      return false;
    }
  }

  return true;
}

export function assertFields(error, expected = {}) {
  if (!matchesFields(error, expected)) {
    const code = error && typeof error === "object" ? error.code : undefined;
    const status = error && typeof error === "object" ? error.statusCode : undefined;
    const message = error && typeof error === "object" ? error.message : String(error);
    throw new Error(
      `Expected shape (code=${expected.code ?? "*"}, statusCode=${expected.statusCode ?? "*"})` +
      ` but got code=${code ?? "n/a"}, statusCode=${status ?? "n/a"}, message=${String(message)}`
    );
  }

  return true;
}

