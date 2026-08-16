import js from "@eslint/js";
import globals from "globals";
import jsdoc from "eslint-plugin-jsdoc";
import prettierConfig from "eslint-config-prettier";

export default [
  {
    ignores: ["node_modules/", "actionlint", "*.tgz", ".npm-release-flow/"],
  },
  js.configs.recommended,
  jsdoc.configs["flat/recommended"],
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    settings: {
      // The sources are JSDoc-typed JS feeding `tsc` checkJs: allow the
      // TypeScript type vocabulary (Record<...>, NodeJS.ProcessEnv, ...).
      jsdoc: { mode: "typescript" },
    },
    rules: {
      // JSDoc feeds `tsc` checkJs. Enforce presence on functions in the
      // shipped code (bin + src); tests document helpers where useful.
      "jsdoc/require-jsdoc": "off",
      "jsdoc/require-param-description": "off",
      "jsdoc/require-returns-description": "off",
      "jsdoc/require-description": "off",
      "jsdoc/tag-lines": "off",
      "jsdoc/reject-any-type": "off",
      // Cross-module typedefs and NodeJS.* namespaces are normal in this
      // codebase; tsc checkJs is the authoritative type-checker.
      "jsdoc/no-undefined-types": "off",
      // Parameters kept for caller compatibility are named `_param`.
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrors: "all" },
      ],
      // The kit spawns subprocesses only through src/lib/spawn.mjs.
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "use src/lib/app-token.mjs for API calls" },
      ],
    },
  },
  {
    files: ["bin/**/*.mjs", "src/**/*.mjs"],
    rules: {
      "jsdoc/require-jsdoc": [
        "error",
        {
          require: {
            FunctionDeclaration: true,
            ClassDeclaration: true,
            MethodDefinition: false,
            ArrowFunctionExpression: false,
          },
        },
      ],
    },
  },
  {
    // Test helpers document their meaning, not their types: the shapes are
    // exercised by the tests themselves, so skip the type/returns ceremony.
    files: ["test/**/*.mjs"],
    rules: {
      "jsdoc/require-returns": "off",
      "jsdoc/require-param-type": "off",
    },
  },
  prettierConfig,
];
