#!/usr/bin/env bun

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..');
const sourceDirectory = path.join(repoRoot, 'skills');
const files = readdirSync(sourceDirectory, { recursive: true });
const sources = files
  .filter(
    (file): file is string =>
      typeof file === 'string' && file.endsWith('.puml'),
  )
  .sort()
  .map((file) => path.join(sourceDirectory, file));

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'prism-diagrams-'));
const inlineOutputs: { source: string; output: string }[] = [];
for (const file of files) {
  if (typeof file !== 'string' || !file.endsWith('.md')) continue;
  const markdownPath = path.join(sourceDirectory, file);
  const markdown = readFileSync(markdownPath, 'utf8');
  const blocks = [...markdown.matchAll(/^```(?:plantuml|puml)\s*\n([\s\S]*?)^```\s*$/gm)];
  for (const [index, block] of blocks.entries()) {
    const source = path.join(temporaryDirectory, `inline-${inlineOutputs.length}.puml`);
    writeFileSync(source, block[1]);
    sources.push(source);
    inlineOutputs.push({ source, output: markdownPath.replace(/\.md$/, `-${index + 1}.png`) });
  }
}

if (sources.length === 0) {
  throw new Error(`No PlantUML sources found in ${sourceDirectory}.`);
}

const plantuml = Bun.which('plantuml');
if (plantuml === null) {
  console.error(
    'PlantUML was not found on PATH. Install PlantUML before running',
  );
  process.exit(1);
}

const renderer = Bun.spawn([plantuml, '-tpng', '-nometadata', ...sources], {
  cwd: repoRoot,
  stdio: ['inherit', 'inherit', 'inherit'],
});
const exitCode = await renderer.exited;

if (exitCode !== 0) {
  rmSync(temporaryDirectory, { recursive: true, force: true });
  process.exit(exitCode);
}

for (const { source, output } of inlineOutputs) {
  copyFileSync(source.replace(/\.puml$/, '.png'), output);
}
rmSync(temporaryDirectory, { recursive: true, force: true });

console.log(`Rendered ${sources.length} PlantUML diagram(s)`);
