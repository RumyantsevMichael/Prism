import { startReviewServer } from "./review-server.mjs";

const [command = "review", artifactPath] = process.argv.slice(2);
if (command !== "review") {
  process.stderr.write("Usage: prism review [artifact-path]\n");
  process.exitCode = 2;
} else {
  const review = await startReviewServer();
  const result = review.open(artifactPath);
  process.stdout.write(`${result.url}\n`);
  const close = async () => {
    await review.close();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
