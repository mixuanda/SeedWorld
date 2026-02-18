#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pngToIco from 'png-to-ico';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resourcesDir = path.join(workspaceRoot, 'resources');
const canonicalPngPath = path.join(resourcesDir, 'icon.png');
const icoPath = path.join(resourcesDir, 'icon.ico');
const icnsPath = path.join(resourcesDir, 'icon.icns');

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function ensureCanonicalPng() {
  if (fileExists(canonicalPngPath)) {
    return canonicalPngPath;
  }

  const fallbackCandidates = [
    path.join(resourcesDir, 'seedworld-icon-dark-1024.png'),
    path.join(resourcesDir, 'seedworld-icon-light-1024.png'),
  ];

  const fallback = fallbackCandidates.find((candidate) => fileExists(candidate));
  if (!fallback) {
    throw new Error(
      `Missing icon source. Expected ${canonicalPngPath} (or fallback seedworld-icon-*-1024.png).`,
    );
  }

  fs.copyFileSync(fallback, canonicalPngPath);
  console.log(`[icons] Created ${canonicalPngPath} from fallback ${path.basename(fallback)}`);
  return canonicalPngPath;
}

async function generateWindowsIco(sourcePngPath) {
  const iconBuffer = await pngToIco(sourcePngPath);
  fs.writeFileSync(icoPath, iconBuffer);
  console.log(`[icons] Generated ${icoPath}`);
}

function generateMacIcns(sourcePngPath) {
  if (process.platform !== 'darwin') {
    console.log('[icons] Skipping .icns generation (macOS only).');
    return;
  }

  const iconsetPath = path.join(resourcesDir, 'icon.iconset');
  fs.rmSync(iconsetPath, { recursive: true, force: true });
  fs.mkdirSync(iconsetPath, { recursive: true });

  const sizes = [
    { size: 16, output: 'icon_16x16.png' },
    { size: 32, output: 'icon_16x16@2x.png' },
    { size: 32, output: 'icon_32x32.png' },
    { size: 64, output: 'icon_32x32@2x.png' },
    { size: 128, output: 'icon_128x128.png' },
    { size: 256, output: 'icon_128x128@2x.png' },
    { size: 256, output: 'icon_256x256.png' },
    { size: 512, output: 'icon_256x256@2x.png' },
    { size: 512, output: 'icon_512x512.png' },
    { size: 1024, output: 'icon_512x512@2x.png' },
  ];

  for (const entry of sizes) {
    execFileSync(
      'sips',
      ['-z', String(entry.size), String(entry.size), sourcePngPath, '--out', path.join(iconsetPath, entry.output)],
      { stdio: 'inherit' },
    );
  }

  execFileSync('iconutil', ['-c', 'icns', iconsetPath, '-o', icnsPath], { stdio: 'inherit' });
  fs.rmSync(iconsetPath, { recursive: true, force: true });
  console.log(`[icons] Generated ${icnsPath}`);
}

async function main() {
  const sourcePngPath = ensureCanonicalPng();
  await generateWindowsIco(sourcePngPath);
  generateMacIcns(sourcePngPath);
}

main().catch((error) => {
  console.error('[icons] Failed to generate icons:', error);
  process.exitCode = 1;
});
