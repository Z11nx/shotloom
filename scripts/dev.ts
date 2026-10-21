export {};
/**
 * `bun run dev`: starts the API server (restarts on change) and the Vite dev
 * server together. Works the same on Windows, macOS and Linux.
 */
const children = [
  Bun.spawn(["bun", "run", "--watch", "server/main.ts"], { stdout: "inherit", stderr: "inherit", stdin: "ignore" }),
  Bun.spawn(["bunx", "--bun", "vite"], { stdout: "inherit", stderr: "inherit", stdin: "ignore" }),
];

console.log("\n  Open http://localhost:5173 once Vite reports it is ready.\n");

const stop = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await Promise.race(children.map((c) => c.exited));
stop();
