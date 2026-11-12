// A preload that delays only the launch supervisor's start past the starter's timeout, as a loaded machine would.
if (process.argv[1]?.includes("launch-supervisor")) await new Promise((resolve) => setTimeout(resolve, 16000));
