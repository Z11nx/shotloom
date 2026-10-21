/**
 * `bun run check`: type check, automated tests, production build.
 * Never contacts fal and never spends money.
 */
export {};
const steps: [string, string[]][] = [
  ["Type check", ["bunx", "tsc", "--noEmit", "-p", "tsconfig.json"]],
  ["Tests", ["bun", "test"]],
  ["Production build", ["bunx", "vite", "build"]],
];
for (const [label, cmd] of steps) {
  console.log(`\n▶ ${label}`);
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", env: { ...process.env, FAL_KEY: "" } });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`\n✖ ${label} failed.`);
    process.exit(code);
  }
}
console.log("\n✔ All checks passed.");
