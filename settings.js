// Shared settings stored in chrome.storage.local.
// "muted" and "volume" keep the same keys as v0.4.x so old values are reused.
export const DEFAULTS = {
  enabled: true,      // redirect live channels to the alternate player
  muted: false,
  volume: 0.5,
  quality: 'auto',    // variant name ("1080p60", "720p60"...) or "auto"
  chat: true,
  chatWidth: 340,
  lowLatency: true,
  stats: false,
};

export function getSettings() {
  return chrome.storage.local.get(DEFAULTS);
}

export function setSettings(patch) {
  return chrome.storage.local.set(patch);
}
