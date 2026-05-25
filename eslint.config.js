import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  // Global ignores
  {
    ignores: [
      "node_modules/",
      "dist/",
      ".vercel/",
      "scratch/",
      "public/",
      "tests/",
    ],
  },

  // Base JS config
  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "no-console": "off",
      "no-unused-vars": "off",
      "no-useless-assignment": "off",
      eqeqeq: "error",
      quotes: ["warn", "double"],
      semi: ["warn", "always"],
      "max-len": ["warn", {
        code: 140,
        ignoreComments: true,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
        ignoreUrls: true,
      }],
      "no-trailing-spaces": "warn",
    },
  },

  // TypeScript - relaxed for practical dev
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      // Disable strict rules for practical development
      "@typescript-eslint/no-explicit-any": "off", // banyak yang butuh
      "@typescript-eslint/no-unused-vars": "off", // Too noisy, let TypeScript handle it
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/prefer-optional-chain": "off",
      "@typescript-eslint/no-unnecessary-type-constraint": "off",

      // Allow development
      "no-console": "off",
      "no-unused-vars": "off",
      "max-len": ["warn", {
        code: 200,
        ignoreComments: true,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
        ignoreUrls: true,
        ignoreRegExpLiterals: true,
      }],
    },
  }
];