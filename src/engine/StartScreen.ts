/**
 * Start Screen — the real title/account overlay (START_SCREEN.md, phase 4).
 *
 * A DOM overlay drawn OVER the pixel canvas (password fields on a canvas are
 * painful). In dev the canvas character-select stays the boot screen; an
 * "ACCOUNTS" button there opens this overlay so we can build/test the account
 * flow without disrupting the existing dev loop. At launch this becomes the boot
 * screen instead.
 *
 * This phase implements TITLE + AUTH (register/login/logout, session persisted
 * via Auth.ts). The START / CONTINUE actions are present but stubbed — the
 * NEW-CHARACTER and CHARACTER-SLOTS flows are the next phases, and wiring them to
 * actually launch the game needs the join-by-token change (phase 7).
 */
import {
  Account,
  ApiError,
  CharacterSummary,
  register,
  login,
  logout,
  me,
  listCharacters,
  deleteCharacter,
} from './Auth';
import { runRomIntake } from '../extract/romAssets';
import { mountCreateFlow } from './charcreate/CreateFlow';
import { loadSpriteCatalog, loadSpriteImage, drawSouthFrame } from './charcreate/spritePreview';
import { ensureEbFont, ebText, ebLabel, ebButton, injectEbChrome } from './EbText';

type Screen = 'title' | 'auth' | 'slots' | 'create';
type AuthTab = 'login' | 'register';

let root: HTMLDivElement | null = null;
let panel: HTMLDivElement | null = null;
let open = false;
let screen: Screen = 'title';
let authTab: AuthTab = 'login';
let account: Account | null = null;

// Set by Game.init — spawns a chosen/created character into the running game.
let onPlay: ((char: CharacterSummary) => void) | null = null;
export function setStartScreenPlayHandler(fn: (char: CharacterSummary) => void): void {
  onPlay = fn;
}

export function isStartScreenOpen(): boolean {
  return open;
}

/** Build the overlay DOM once (hidden). Safe to call multiple times. */
export function initStartScreen(): void {
  if (root) return;
  injectStyles();
  injectEbChrome();
  void ensureEbFont(); // preload the EB bitmap font so labels render in it

  root = document.createElement('div');
  root.className = 'eb-ss-root';
  root.style.display = 'none';
  // Swallow clicks on the backdrop (don't fall through to the canvas).
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) e.stopPropagation();
  });

  panel = document.createElement('div');
  panel.className = 'eb-ss-panel';
  root.appendChild(panel);

  document.body.appendChild(root);
}

/** Show the overlay and refresh account state from the stored token. */
export function openStartScreen(): void {
  if (!root) initStartScreen();
  open = true;
  root!.style.display = 'flex';
  screen = 'title';
  render();
  // Re-render once the EB font is ready so labels swap from the fallback.
  void ensureEbFont().then(() => {
    if (open) render();
  });
  // Validate any stored session in the background; if signed in, jump to the
  // character slots, else stay on the signed-out title.
  void me()
    .then((a) => {
      account = a;
      if (!open) return;
      if (account) screen = 'slots';
      render();
    })
    .catch(() => {
      /* network hiccup — stay signed-out for now */
    });
}

export function closeStartScreen(): void {
  open = false;
  if (root) root.style.display = 'none';
}

// ------------------------------- rendering -------------------------------

function render(): void {
  if (!panel) return;
  panel.innerHTML = '';
  // The creator spreads its panes across the screen, so it needs a wider column
  // than the 420px form screens. Toggled off whenever we leave the create screen.
  panel.classList.toggle('eb-ss-panel--wide', screen === 'create');
  // The creator fits itself to the viewport (CreateFlow.fitToViewport scales it),
  // so it must NEVER scroll — lock the page. Other screens keep auto-scroll for
  // tiny viewports.
  root?.classList.toggle('eb-ss-root--fixed', screen === 'create');
  if (screen === 'create') {
    // The create flow owns the whole panel (it has its own Back button).
    panel.appendChild(closeButton());
    void mountCreateFlow(panel, {
      onCancel: () => {
        screen = 'slots';
        render();
      },
      onCreated: (char) => play(char), // happy with it → spawn in
    });
    return;
  }
  panel.appendChild(closeButton());
  if (screen === 'slots') renderSlots();
  else if (screen === 'auth') renderAuth();
  else renderTitle();
}

// Signed-out landing.
function renderTitle(): void {
  const p = panel!;
  p.appendChild(heading('199X'));

  if (import.meta.env.DEV) {
    // DEV: skip the form — START signs into a throwaway guest account instantly
    // and jumps to the character creator (no name/pass/ROM). Compiled out of prod.
    p.appendChild(note('Dev mode — no sign-in needed'));
    p.appendChild(button('START', 'primary', () => void devGuestToCreator()));
    p.appendChild(button('Real login…', 'ghost', () => gotoAuth('login')));
    return;
  }

  p.appendChild(note('Sign in to save your progress'));
  p.appendChild(
    button('START', 'primary', () => {
      if (account) {
        screen = 'slots';
        render();
      } else gotoAuth('login');
    })
  );
}

// DEV-only: silently ensure a guest session (login, or register on first run),
// then go straight to the creator. No credentials typed, no ROM prompt.
async function devGuestToCreator(): Promise<void> {
  if (!account) {
    try {
      account = await login('devguest', 'devguest123');
    } catch {
      try {
        account = await register('devguest', 'devguest123');
      } catch (e) {
        console.error('dev guest sign-in failed', e);
        return;
      }
    }
  }
  screen = 'create';
  render();
}

// Signed-in: the 3 character slots. Empty slot = "Create New"; a filled slot
// shows sprite + name + level and resumes (Continue) on click.
function renderSlots(): void {
  const p = panel!;
  p.appendChild(heading('YOUR CHARACTERS'));
  if (account) p.appendChild(note(`Signed in as ${account.username}`));

  const list = el('div', 'eb-ss-slots');
  p.appendChild(list);
  const loading = note('Loading…');
  list.appendChild(loading);

  void Promise.all([listCharacters(), loadSpriteCatalog()])
    .then(([res]) => {
      list.innerHTML = '';
      for (let slot = 0; slot < res.max; slot++) {
        const char = res.characters.find((c) => c.slot === slot);
        list.appendChild(char ? filledSlot(char) : emptySlot());
      }
    })
    .catch(() => {
      loading.textContent = 'Could not load your characters.';
    });

  p.appendChild(
    button('Log out', 'ghost', async () => {
      await logout();
      account = null;
      screen = 'title';
      render();
    })
  );
}

function emptySlot(): HTMLElement {
  const box = el('button', 'eb-ss-slot eb-win eb-ss-slot-empty') as unknown as HTMLButtonElement;
  box.appendChild(ebText('+ Create New', 2, '#9fb0d0'));
  box.addEventListener('click', () => {
    screen = 'create';
    render();
  });
  return box;
}

function filledSlot(char: CharacterSummary): HTMLElement {
  // A relative wrapper so the corner ✕ delete button can sit over the slot (a
  // <button> can't legally nest another <button>). The wrapper swaps between the
  // normal slot and an inline "Delete NAME?" confirm — deleting is permanent, so
  // never one-click.
  const wrap = el('div', 'eb-ss-slot-wrap');

  const showNormal = (): void => {
    wrap.innerHTML = '';
    const box = el('button', 'eb-ss-slot eb-win') as unknown as HTMLButtonElement;
    box.type = 'button';
    const cv = document.createElement('canvas');
    cv.width = 40;
    cv.height = 48;
    cv.className = 'eb-ss-slot-sprite';
    box.appendChild(cv);
    const info = el('div', 'eb-ss-slot-info');
    const level = typeof char.save?.level === 'number' ? char.save.level : 1;
    info.appendChild(ebText(char.name, 2, '#ffffff'));
    info.appendChild(ebText(`Lv ${level}`, 1, '#f8e85a'));
    box.appendChild(info);
    box.addEventListener('click', () => play(char));
    // Draw the sprite once its sheet loads.
    void loadSpriteImage(char.spriteGroupId, char.appearance).then((img) => {
      drawSouthFrame(cv.getContext('2d')!, img, char.spriteGroupId, cv.width, cv.height, 2);
    });
    const del = el('button', 'eb-ss-del') as unknown as HTMLButtonElement;
    del.type = 'button';
    del.textContent = '✕';
    del.title = `Delete ${char.name}`;
    del.addEventListener('click', (e) => {
      e.stopPropagation(); // don't fall through to play(char)
      showConfirm();
    });
    wrap.appendChild(box);
    wrap.appendChild(del);
  };

  const showConfirm = (): void => {
    wrap.innerHTML = '';
    const box = el('div', 'eb-ss-slot eb-win eb-ss-slot-confirm');
    box.appendChild(ebText(`Delete ${char.name}? This can't be undone.`, 1, '#ff8a8a'));
    const row = div('eb-ss-confirm-row');
    const del = button('Delete', 'primary', async () => {
      del.disabled = true;
      try {
        await deleteCharacter(char.id);
        render(); // refresh the slots — the freed slot reopens as "+ Create New"
      } catch {
        del.disabled = false;
        box.appendChild(ebText('Could not delete. Try again.', 1, '#ff6a6a'));
      }
    });
    row.appendChild(del);
    row.appendChild(button('Cancel', 'ghost', showNormal));
    box.appendChild(row);
    wrap.appendChild(box);
  };

  showNormal();
  return wrap;
}

// Close the overlay and hand the character to the game to spawn.
function play(char: CharacterSummary): void {
  closeStartScreen();
  onPlay?.(char);
}

function renderAuth(): void {
  const p = panel!;
  p.appendChild(heading(authTab === 'login' ? 'LOG IN' : 'REGISTER'));

  // Tabs
  const tabs = div('eb-ss-tabs');
  tabs.appendChild(tabButton('Log In', authTab === 'login', () => gotoAuth('login')));
  tabs.appendChild(tabButton('Register', authTab === 'register', () => gotoAuth('register')));
  p.appendChild(tabs);

  const registering = authTab === 'register';
  const user = field('Account Name', 'text', 'username');
  const pass = field('Password', 'password', registering ? 'new-password' : 'current-password');
  p.appendChild(user.wrap);
  p.appendChild(pass.wrap);

  // Register requires confirming the password matches.
  const confirm = registering ? field('Confirm Password', 'password', 'new-password') : null;
  if (confirm) p.appendChild(confirm.wrap);

  // ROM intake (under the confirm-password field). Players supply their own
  // EarthBound ROM — assets are extracted client-side and never uploaded
  // (PokeMMO model). For testing this runs INDEPENDENTLY of the account fields:
  // clicking it starts the client-side extraction now, even with the form empty.
  if (registering) {
    const rom = div('eb-ss-rom');
    rom.appendChild(
      note('Supply your EarthBound ROM — verified and kept in your browser, never uploaded.')
    );
    rom.appendChild(button('Load ROM…', 'ghost', () => void runRomIntake()));
    p.appendChild(rom);
  }

  const err = div('eb-ss-error');
  p.appendChild(err);

  const submit = button(registering ? 'Create Account' : 'Log In', 'primary', async () => {
    err.textContent = '';
    const u = user.input.value.trim();
    const pw = pass.input.value;
    if (!u || !pw) {
      err.textContent = 'Enter an account name and password.';
      return;
    }
    if (confirm && pw !== confirm.input.value) {
      err.textContent = "Passwords don't match.";
      return;
    }
    submit.disabled = true; // (label is an EB-font canvas; don't overwrite it)
    try {
      account = registering ? await register(u, pw) : await login(u, pw);
      screen = 'slots';
      render();
    } catch (e) {
      err.textContent = e instanceof ApiError ? e.message : 'Something went wrong. Try again.';
      submit.disabled = false;
    }
  });
  p.appendChild(submit);

  // Enter submits from any field.
  for (const el of [user.input, pass.input, ...(confirm ? [confirm.input] : [])]) {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit.click();
      }
    });
  }

  p.appendChild(button('‹ Back', 'ghost', () => gotoTitle()));
  user.input.focus();
}

function gotoAuth(tab: AuthTab): void {
  authTab = tab;
  screen = 'auth';
  render();
}
function gotoTitle(): void {
  screen = 'title';
  render();
}

// ------------------------------- DOM helpers -------------------------------

function div(cls: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}

// Generic element with a class (used for the slot buttons/containers).
function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

function heading(text: string): HTMLElement {
  return ebLabel(text, 3, '#f8e85a'); // big EB-yellow title
}
function subheading(text: string): HTMLElement {
  return ebLabel(text, 2, '#ffffff');
}
function note(text: string): HTMLElement {
  return ebLabel(text, 1, '#9fb0d0');
}

// Variant kept for call-site compatibility; EB menu buttons look the same.
function button(
  label: string,
  _variant: 'primary' | 'ghost',
  onClick: () => void
): HTMLButtonElement {
  const b = ebButton(label, onClick, 2);
  b.style.justifyContent = 'center'; // center stand-alone buttons
  return b;
}

function tabButton(label: string, active: boolean, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'eb-ss-tab' + (active ? ' active' : '');
  b.appendChild(ebText(label, 2, active ? '#f8e85a' : '#7c89a8'));
  b.addEventListener('click', onClick);
  return b;
}

function field(
  label: string,
  type: string,
  autocomplete: string
): { wrap: HTMLDivElement; input: HTMLInputElement } {
  const wrap = div('eb-ss-field');
  wrap.appendChild(ebText(label, 1, '#9fb0d0'));
  const input = document.createElement('input');
  input.type = type;
  input.setAttribute('autocomplete', autocomplete);
  input.spellcheck = false;
  wrap.appendChild(input);
  return { wrap, input };
}

function closeButton(): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'eb-ss-close';
  b.textContent = '×';
  b.title = 'Back to character select (dev)';
  b.addEventListener('click', () => closeStartScreen());
  return b;
}

// ------------------------------- styles -------------------------------

function injectStyles(): void {
  if (document.getElementById('eb-ss-styles')) return;
  const css = `
  .eb-ss-root {
    position: fixed; inset: 0; z-index: 1000;
    /* Full opaque page — covers the dev character-select entirely. */
    background: #0b0b16;
    display: flex; flex-direction: column; align-items: center;
    overflow-y: auto;            /* tall content (the creator) scrolls */
    padding: 24px 16px;
    font-family: 'Courier New', monospace;
    -webkit-font-smoothing: none;
  }
  /* Create screen: one page, never scrolls — the creator scales to fit instead. */
  .eb-ss-root--fixed { overflow: hidden; }
  /* Not a modal card — a centered content column ON the full page. */
  .eb-ss-panel {
    position: relative;
    margin: auto;                /* center when it fits, scroll when it doesn't */
    width: 420px; max-width: calc(100vw - 32px);
    background: transparent;
    padding: 8px 4px 24px;
    color: #fff;
    display: flex; flex-direction: column; gap: 12px;
  }
  /* Character creator: a wide column so its EB panes can sit side by side. TOP-
     aligned (margin:0 auto, not auto) because it scales itself to fit the
     viewport — the content is anchored to the top and clipped-free, while the
     unscaled layout box's empty tail below is hidden by .eb-ss-root--fixed. */
  .eb-ss-panel--wide { width: min(1100px, calc(100vw - 32px)); margin: 0 auto; }
  /* Title block: a little breathing room between the EB-font canvases. */
  .eb-ss-panel > .eb-label { margin: 2px 0; }
  .eb-ss-tabs { display: flex; gap: 8px; margin-bottom: 4px; }
  .eb-ss-tab {
    flex: 1; padding: 8px; cursor: pointer;
    background: #000; border: 2px solid #334; border-radius: 6px;
    display: flex; justify-content: center;
  }
  .eb-ss-tab.active { border-color: #f8e85a; }
  .eb-ss-tab canvas { image-rendering: pixelated; }
  .eb-ss-field { display: flex; flex-direction: column; gap: 4px; }
  /* Inputs keep a system font (typed text in the bitmap font needs canvas sync,
     a later pass) but wear EB colors: black field, white text, yellow focus. */
  .eb-ss-field input {
    font-family: 'Courier New', monospace; font-size: 15px; padding: 9px;
    background: #000; color: #fff; border: 2px solid #fff; border-radius: 5px;
  }
  .eb-ss-field input:focus { outline: none; border-color: #f8e85a; }
  .eb-ss-rom {
    display: flex; flex-direction: column; gap: 8px;
    margin-top: 6px; padding-top: 12px; border-top: 1px solid #334;
  }
  .eb-ss-error { color: #ff6b6b; font-size: 13px; min-height: 16px; text-align: center; }
  /* Fixed to the page corner. */
  .eb-ss-close {
    position: fixed; top: 10px; right: 14px; z-index: 1;
    width: 30px; height: 30px; line-height: 26px;
    background: transparent; color: #667; border: none; cursor: pointer;
    font-size: 26px; font-family: 'Courier New', monospace;
  }
  .eb-ss-close:hover { color: #fff; }
  .eb-ss-slots { display: flex; flex-direction: column; gap: 10px; margin: 4px 0; }
  /* Slots reuse the EB window (.eb-win); this adds layout + the selection feel. */
  .eb-ss-slot {
    display: flex; align-items: center; gap: 12px; width: 100%;
    cursor: pointer; text-align: left;
  }
  .eb-ss-slot:hover, .eb-ss-slot:focus-visible { border-color: #f8e85a; outline: none; background: #0c0c1a; }
  .eb-ss-slot-empty { justify-content: center; min-height: 60px; border-style: dashed; }
  .eb-ss-slot-sprite { image-rendering: pixelated; background: #0a0a14; border-radius: 3px; flex: none; }
  .eb-ss-slot-info { display: flex; flex-direction: column; gap: 4px; }
  .eb-ss-slot-info canvas { image-rendering: pixelated; }
  /* Corner delete (✕): floats over the slot's top-right; the wrapper is relative. */
  .eb-ss-slot-wrap { position: relative; display: block; width: 100%; }
  .eb-ss-del {
    position: absolute; top: 6px; right: 6px; z-index: 2;
    width: 18px; height: 18px; padding: 0; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    background: #1a1020; color: #ff8a8a; font: 12px monospace; cursor: pointer;
    border: 1px solid #5a2030; border-radius: 3px;
  }
  .eb-ss-del:hover, .eb-ss-del:focus-visible { background: #d8281c; color: #fff; border-color: #f8e85a; outline: none; }
  .eb-ss-slot-confirm { flex-direction: column; align-items: stretch; gap: 8px; cursor: default; }
  .eb-ss-confirm-row { display: flex; gap: 8px; }
  .eb-ss-confirm-row button { flex: 1; }
  `;
  const style = document.createElement('style');
  style.id = 'eb-ss-styles';
  style.textContent = css;
  document.head.appendChild(style);
}
