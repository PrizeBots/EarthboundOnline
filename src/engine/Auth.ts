/**
 * Auth client — the browser side of the account/session API (server/authApi.js).
 *
 * Owns the session token: it lives in localStorage under `eb_session` and is
 * sent as `Authorization: Bearer <token>` on authenticated calls. Everything that
 * needs an account (the Start Screen now; the multiplayer join later, phase 7)
 * goes through here, so there's one place that knows the wire format + storage.
 */

const TOKEN_KEY = 'eb_session';

export interface Account {
  id: number;
  username: string;
  createdAt: number;
}

export interface CharacterSummary {
  id: number;
  slot: number;
  name: string;
  spriteGroupId: number;
  appearance: string | null;
  save: Record<string, unknown>;
  updatedAt: number;
}

/** A non-2xx API response. `status` is the HTTP code; `message` is the server's `error`. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

interface ApiOpts {
  method?: string;
  body?: unknown;
  auth?: boolean;
}

async function api<T>(
  path: string,
  { method = 'GET', body, auth = false }: ApiOpts = {}
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth) {
    const t = getToken();
    if (t) headers['authorization'] = `Bearer ${t}`;
  }
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty/no-JSON body (e.g. some errors) */
  }
  if (!res.ok) {
    const serverError =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : '';
    throw new ApiError(res.status, serverError || `HTTP ${res.status}`);
  }
  return data as T;
}

// ------------------------------- auth -------------------------------

export async function register(username: string, password: string): Promise<Account> {
  const d = await api<{ token: string; account: Account }>('/api/register', {
    method: 'POST',
    body: { username, password },
  });
  setToken(d.token);
  return d.account;
}

export async function login(username: string, password: string): Promise<Account> {
  const d = await api<{ token: string; account: Account }>('/api/login', {
    method: 'POST',
    body: { username, password },
  });
  setToken(d.token);
  return d.account;
}

export async function logout(): Promise<void> {
  try {
    await api('/api/logout', { method: 'POST', auth: true });
  } finally {
    clearToken(); // drop the local token even if the network call fails
  }
}

/** Resolve the stored token to an account, or null if absent/expired (and clears it). */
export async function me(): Promise<Account | null> {
  if (!getToken()) return null;
  try {
    const d = await api<{ account: Account }>('/api/me', { auth: true });
    return d.account;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      clearToken();
      return null;
    }
    throw e;
  }
}

// ---------------------------- characters ----------------------------

export async function listCharacters(): Promise<{ characters: CharacterSummary[]; max: number }> {
  return api('/api/characters', { auth: true });
}

export async function createCharacter(input: {
  name: string;
  spriteGroupId: number;
  appearance?: string | null;
  // The 5-stat creation allocation (server validates + derives combat stats).
  alloc: Record<string, number>;
  // EarthBound naming prompts — flavor, stored in the character save.
  favoriteThing?: string;
  favoriteFood?: string;
}): Promise<CharacterSummary> {
  const d = await api<{ character: CharacterSummary }>('/api/characters', {
    method: 'POST',
    body: input,
    auth: true,
  });
  return d.character;
}

export async function deleteCharacter(id: number): Promise<void> {
  await api(`/api/characters/${id}`, { method: 'DELETE', auth: true });
}

// ------------------------- world documents (admin) -------------------------
// Authored world content (the Places outline, etc.) lives in the DB. Reads are
// public; writes require an admin session (or trusted localhost in dev).

/** Fetch an authored world document by name, or null if none saved yet. */
export async function loadWorldDoc<T>(name: string): Promise<T | null> {
  const d = await api<{ name: string; data: T | null }>(`/api/world/${name}`);
  return d.data;
}

/** Persist an authored world document (admin-only on the server). */
export async function saveWorldDoc(name: string, data: unknown): Promise<void> {
  await api(`/api/world/${name}`, { method: 'PUT', body: { data }, auth: true });
}
