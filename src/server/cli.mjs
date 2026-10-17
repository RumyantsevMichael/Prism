import { startStandaloneReview } from "./review/review-server-pool.mjs";

const USAGE = "Usage: prism review [artifact-path]\n\nOpens the Prism review browser for the project in the current directory.\nWithout an artifact path, the browser opens on Attention.\n";

const [command = "review", artifactPath, ...extra] = process.argv.slice(2);
if (["-h", "--help", "help"].includes(command) || ["-h", "--help"].includes(artifactPath)) {
  process.stdout.write(USAGE);
} else if (command !== "review" || extra.length) {
  process.stderr.write(USAGE);
  process.exitCode = 2;
} else {
  let result;
  try {
    result = await startStandaloneReview({ artifactPath });
  } catch (error) {
    process.stderr.write(`prism review: ${error.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`${result.url}\n`);
  // The shared review app keeps serving after this command returns; only a review served by this command needs it to keep running.
  if (result.held) {
    const close = async () => {
      await result.held.close();
      process.exit(0);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  } else if (!result.opened) {
    process.stderr.write("prism review: no new browser tab opened; an open review tab shows this project or a notice with its link, or open the URL above.\n");
  }
}
