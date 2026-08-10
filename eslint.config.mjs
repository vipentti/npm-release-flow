import js from "@eslint/js";
import globals from "globals";
import jsdoc from "eslint-plugin-jsdoc";
import prettierConfig from "eslint-config-prettier";

export default [
  {
    ignores: ["node_modules/", "actionlint", "*.tgz"],
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
    rules: {
      // JSDoc types feed `tsc` checkJs; require well-formed docs on
      // exported functions without being noisy about internal details.
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
      "jsdoc/require-param-type": "off",
      "jsdoc/require-returns-type": "off",
      "jsdoc/require-description": "off",
      // The kit spawns subprocesses only through src/lib/spawn.mjs.
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "use src/lib/app-token.mjs for API calls" },
      ],
    },
  },
  prettierConfig,
];
