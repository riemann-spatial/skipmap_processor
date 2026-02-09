import { runCommand } from "../utils/ProcessRunner";
import { Logger } from "../utils/Logger";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    Logger.log("Usage: extract_tiles <input.mbtiles> <output_dir>");
    process.exit(1);
  }

  await runCommand("tile-join", [
    "--no-tile-size-limit",
    "--output-to-directory",
    args[1],
    args[0],
  ]);
}

if (require.main === module) {
  main();
}
