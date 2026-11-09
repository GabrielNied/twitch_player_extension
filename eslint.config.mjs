// Catches references to names that don't exist (a function removed by
// mistake left the player stuck on "Conectando à live"). Run: npx eslint@9 .
const browser = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly', console: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', Blob: 'readonly', MediaMetadata: 'readonly',
  addEventListener: 'readonly', innerWidth: 'readonly', crypto: 'readonly', performance: 'readonly', CSS: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', WebSocket: 'readonly', localStorage: 'readonly', Node: 'readonly',
  chrome: 'readonly', Hls: 'readonly',
};

export default [
  { ignores: ['lib/**', 'tizen/app/**', 'tizen/node_modules/**', 'tizen/dist/**'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: browser },
    rules: { 'no-undef': 'error' },
  },
  { files: ['tizen/src/**'], languageOptions: { globals: { webapis: 'readonly', tizen: 'readonly' } } },
  { files: ['tools/**', 'tizen/build.mjs', 'eslint.config.mjs'], languageOptions: { globals: { process: 'readonly' } } },
];
