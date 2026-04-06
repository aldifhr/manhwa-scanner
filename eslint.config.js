import js from "@eslint/js";
import globals from "globals";

export default [
  // Global ignores
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
      // Basic rules - relaxed for practical development
      "no-console": "off",
      "no-unused-vars": "off",
      "no-useless-assignment": "off",
      "no-undef": "off",
      eqeqeq: "error",

      // Code style consistency - warnings only (don't break build)
      quotes: ["warn", "double", { avoidEscape: true }],
      semi: ["warn", "always"],
      indent: ["warn", 2],
      "max-len": [
        "warn",
        {
          code: 120,
          ignoreComments: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
        },
      ],

      // Import consistency - relaxed (manual sorting is fine)
      "sort-imports": "off",

      // Function style - suggestions only
      "func-style": ["off", "declaration", { allowArrowFunctions: true }],
      "arrow-body-style": ["off", "as-needed"],

      // Variable naming - relaxed to allow snake_case for API data
      camelcase: [
        "warn",
        {
          properties: "never",
          ignoreDestructuring: true,
          ignoreImports: true,
          allow: [
            "shinigami_project",
            "shinigami_mirror",
            "ikiru",
            "discord_id",
            "custom_id",
          ],
        },
      ],

      // Spacing and formatting - warnings only
      "space-before-function-paren": [
        "warn",
        {
          anonymous: "always",
          named: "never",
          asyncArrow: "always",
        },
      ],
      "comma-dangle": ["warn", "always-multiline"],
      "object-curly-spacing": ["warn", "always"],
      "array-bracket-spacing": ["warn", "never"],

      // Best practices - suggestions
      "prefer-const": "warn",
      "no-var": "warn",
      "prefer-template": "off",
      "template-curly-spacing": "warn",
      "no-trailing-spaces": "warn",
      "eol-last": "warn",
    },
  },

  // Override for test files - more relaxed rules
  {
    files: ["tests/**/*.js", "**/*.test.js"],
    rules: {
      // Allow snake_case in tests (for API data matching)
      camelcase: "off",
      // Allow longer lines in tests
      "max-len": ["warn", { code: 150 }],
      // Don't require strict function styles in tests
      "func-style": "off",
    },
  },
];
