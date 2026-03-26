import js from "@eslint/js";
import globals from "globals";

export default [
  // Global ignores (ganti .eslintignore)
  {
    ignores: [
      "node_modules/",
      "dist/",
      ".vercel/",
      "*.test.js",
      "test-*.js",
      "bulk-add.js",
      "flush.js",
      "migrate.js",
      "cron.js",
    ],
  },

  // Main config
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "no-console": "off",
      "no-unused-vars": "warn",
      "no-useless-assignment": "off",
      "no-undef": "off",
      eqeqeq: "error",
    },
  },
];
