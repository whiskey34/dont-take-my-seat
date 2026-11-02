import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist', 'android', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      eqeqeq: 'error',
    },
  },
  {
    // The rules of the game must stay free of rendering, DOM and input code
    // so they can be unit-tested and later run on the multiplayer host.
    files: ['src/core/**/*.ts', 'src/ai/**/*.ts'],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-imports': ['error', { patterns: ['three', 'three/*', '../render/*', '../ui/*', '../input/*', '../audio/*'] }],
    },
  },
);
