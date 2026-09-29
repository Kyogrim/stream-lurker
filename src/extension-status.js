// Wording for the 1-click login panel in Platform Logins, from what main
// reports through get-extension-info. Pure functions returning plain text;
// src/login.js puts them on the page with textContent.

// Platform names shown to the user. Anything else main (or a stray payload)
// reports is never echoed back.
const PLATFORM_LABELS = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick' };

// main's own error strings are short; the cap keeps a surprise from filling
// the panel.
const MAX_ERROR_CHARS = 200;

function cleanError(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_CHARS);
}

// "just now", "5 min ago", "3 h ago", "2 days ago".
export function timeAgo(ms) {
  const s = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

// The receiver line next to the pairing code. Port 0 means nothing is
// listening, and receiverError says why (every candidate port refused), which
// is the one thing that explains an extension that finds no app.
export function receiverStatus(info) {
  const port = Number(info?.port);
  if (Number.isInteger(port) && port > 0) {
    return { text: `· receiver active (port ${port})`, tone: 'ok' };
  }
  const why = cleanError(info?.receiverError);
  return why
    ? { text: `· receiver not running: ${why} The extension cannot reach the app until this is fixed; the app keeps retrying.`, tone: 'error' }
    : { text: '· receiver not started', tone: 'muted' };
}

// The line about the extension's last automatic re-sync, or null when there
// is nothing to say. `last` is get-extension-info's lastAutoSync:
// { at: epoch ms, platform, ok: boolean, error: string }.
export function lastSyncNotice(last, now = Date.now()) {
  if (!last || typeof last !== 'object') return null;
  const at = Number(last.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  const name = Object.hasOwn(PLATFORM_LABELS, last.platform) ? PLATFORM_LABELS[last.platform] : 'an account';
  const ago = timeAgo(now - at);
  if (last.ok === true) {
    return { text: `Extension last synced ${name} ${ago}.`, warn: false };
  }
  const why = cleanError(last.error);
  const reason = why ? `: ${why}${/[.!?]$/.test(why) ? '' : '.'}` : '.';
  return {
    text: `The extension's last automatic sync of ${name} failed ${ago}${reason} If the pairing code changed, paste the current one into the extension.`,
    warn: true,
  };
}

// The re-sync line from the whole get-extension-info payload ({ lastAutoSync,
// autoSync, codeRejectedAt }), or null when there is nothing to say.
// lastAutoSync alone hides failures: the extension re-syncs Twitch, YouTube
// and Kick in one pass and each attempt overwrites it, so a failing YouTube
// read as "last synced Kick just now". autoSync keeps the latest attempt per
// platform ({ at, ok, error }). A wrong pairing code is refused before main
// can tell an automatic import from a manual one, so it appears only as
// codeRejectedAt (epoch ms, 0 when never).
export function extensionSyncNotice(info, now = Date.now()) {
  const perPlatform = info?.autoSync && typeof info.autoSync === 'object' ? info.autoSync : {};
  const entries = [];
  for (const platform of Object.keys(PLATFORM_LABELS)) {
    const entry = Object.hasOwn(perPlatform, platform) ? perPlatform[platform] : null;
    const at = Number(entry?.at);
    if (entry && typeof entry === 'object' && Number.isFinite(at) && at > 0) {
      entries.push({ name: PLATFORM_LABELS[platform], at, ok: entry.ok === true, error: entry.error });
    }
  }
  const failed = entries.filter(e => !e.ok).sort((a, b) => b.at - a.at);
  const newestOk = Math.max(0, ...entries.filter(e => e.ok).map(e => e.at));
  const rejectedAt = Number(info?.codeRejectedAt);
  const codeRejected = Number.isFinite(rejectedAt) && rejectedAt > newestOk;

  const parts = [];
  if (codeRejected) {
    parts.push(`An import with a wrong pairing code was refused ${timeAgo(now - rejectedAt)}. If that was your browser extension, paste the current code shown above into it.`);
  }
  if (failed.length) {
    // A per-platform failure got past the pairing code, so the code is not
    // the problem there.
    const [latest, ...others] = failed;
    const why = cleanError(latest.error);
    const reason = why ? `: ${why}${/[.!?]$/.test(why) ? '' : '.'}` : '.';
    const also = others.length ? ` ${others.map(e => e.name).join(' and ')} failed too.` : '';
    parts.push(`The extension's last automatic sync of ${latest.name} failed ${timeAgo(now - latest.at)}${reason}${also} Log in to ${others.length ? 'them' : latest.name} in your browser, then click Connect in the extension.`);
  }
  if (parts.length) return { text: parts.join(' '), warn: true };
  return lastSyncNotice(info?.lastAutoSync, now);
}

// What to tell the user when Open Extension Folder failed, or null when it
// worked. main answers { success, error, path }; an older main answered
// nothing useful, which is treated as success.
export function folderOpenFailure(res) {
  if (!res || res.success !== false) return null;
  const why = cleanError(res.error) || 'unknown error';
  const where = typeof res.path === 'string' && res.path ? ` Folder: ${res.path}` : '';
  return `Could not open the extension folder (${why}).${where}`;
}
