import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  { ignores: [".next/**", "node_modules/**", "supabase/**", "next-env.d.ts", "playwright-report/**", "test-results/**", ".claude/**"] },
  ...nextVitals,
  ...nextTs,
  {
    // getNow() in lib/time.ts is the only clock (CLAUDE.md engineering conventions).
    files: ["app/**", "components/**", "lib/**"],
    ignores: ["lib/time.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: "Use getNow() from lib/time.ts." },
        { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: "Use getNow() from lib/time.ts." },
      ],
    },
  },
];

export default config;
