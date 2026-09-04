import next from "eslint-config-next";

const config = [
  ...next,
  { ignores: ["node_modules/**", ".next/**", ".omx/**", "out/**", "next-env.d.ts", "playwright-report/**", "test-results/**"] },
];

export default config;
