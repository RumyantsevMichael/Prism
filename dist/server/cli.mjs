import { startReviewServer } from "./review/review-server.mjs";

const USAGE = "Usage: prism review [artifact-path]\n\nOpens the Prism review browser for the project in the current directory.\nWithout an artifact path, the browser opens on Attention.\n";

const [command = "review", artifactPath, ...extra] = process.argv.slice(2);
if (["-h", "--help", "help"].includes(command) || ["-h", "--help"].includes(artifactPath)) {
  process.stdout.write(USAGE);
} else if (command !== "review" || extra.length) {
  process.stderr.write(USAGE);
  process.exitCode = 2;
} else {
  let review;
  try {
    review = await startReviewServer();
    const result = await review.open(artifactPath);
    process.stdout.write(`${result.url}\n`);
    if (review.trustInstructions) {
      process.stdout.write(`${review.trustInstructions}\n`);
    }
  } catch (error) {
    process.stderr.write(`prism review: ${error.message}\n`);
    await review?.close();
    process.exit(1);
  }
  const close = async () => {
    await review.close();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
