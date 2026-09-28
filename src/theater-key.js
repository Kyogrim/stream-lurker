// When a Twitch cell may be sent a native Alt+T (Twitch's theatre-mode hotkey).
//
// The guest page asks for it by logging "[Twitch Theater] Need Alt+T" every
// 3 s while it can't find the theatre button. Acting on every request used to
// pull keyboard focus into that cell every 3 s for as long as the cell was
// open, out of whatever the user was typing in, and any page script could
// print the string. So a request is honoured only from a Twitch page, only
// while the user can see the cell and is not typing anywhere, and at most
// ALT_T_PER_PAGE times per page load. The cap is 1 on purpose: if a delivered
// Alt+T does not satisfy the page, its theatre detection is what's broken, and
// a second press would just switch theatre mode back off.

import { safeHttpsUrl } from './state.js';

export const ALT_T_PER_PAGE = 1;
const TWITCH_HOSTS = ['twitch.tv'];

// ctx.focusOwner describes document.activeElement relative to this cell's
// webview: 'self', 'none' (body), 'editable' (input, textarea, select,
// contenteditable), 'webview' (another cell or portal), or 'other'.
export function theaterKeyDecision(sentThisPage, ctx = {}) {
  if (!safeHttpsUrl(ctx.url, TWITCH_HOSTS)) return { send: false, reason: 'not-twitch' };
  if (sentThisPage >= ALT_T_PER_PAGE) return { send: false, reason: 'cap' };
  // sendInputEvent needs the window focused, and theatre mode only matters to
  // someone looking at the cell; an unseen cell waits until it is seen.
  if (!ctx.windowFocused || !ctx.cellVisible) return { send: false, reason: 'not-visible' };
  if (ctx.focusOwner === 'editable' || ctx.focusOwner === 'webview') return { send: false, reason: 'user-busy' };
  return { send: true, focus: ctx.focusOwner !== 'self', reason: 'ok' };
}
