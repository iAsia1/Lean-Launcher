/**
 * bundle-java.js
 * Downloads and extracts a minimal JRE for bundling with the Electron app.
 * Uses Eclipse Temurin 21 (LTS) — compatible with Minecraft 1.19.4 through 1.21.x.
 *
 * Usage: node scripts/bundle-java.js [--platform=win32|linux|darwin] [--arch=x64|arm64]
 * In CI, platform and arch are auto-detected from the runner.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');
const { createWriteStream, createReadStream } = require('fs');
const { pipeline } = require('stream/promises');
const { Extract } = require('unzipper'); // may need: npm install --no-save unzipper

const JRE_DIR = path.join(__dirname, '..', 'jre');
const JAVA_VERSION = 21;
const ADOPTIUM_API = 'https://api.adoptium.net/v3';

function parseArgs() {
  const args = {
    platform: process.platform,
    arch: process.arch === 'arm64' ? 'aarch64' : 'x64',
    force: false
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === '--force') {
      args.force = true;
    } else if (arg.startsWith('--platform=')) {
      args.platform = arg.split('=')[1];
    } else if (arg.startsWith('--arch=')) {
      args.arch = arg.split('=')[1];
    }
  }

  return args;
}

function mapPlatform(platform) {
  switch (platform) {
    case 'win32': return 'windows';
    case 'darwin': return 'mac';
    case 'linux': return 'linux';
    default: throw new Error(`Unsupported platform: ${platform}`);
  }
}

function mapArch(arch) {
  switch (arch) {
    case 'x64': return 'x64';
    case 'aarch64': return 'aarch64';
    default: throw new Error(`Unsupported architecture: ${arch}`);
  }
}

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, { headers: { 'Accept': 'application/json' } }, (redirectRes) => {
          let data = '';
          redirectRes.on('data', chunk => data += chunk);
          redirectRes.on('end', () => {
            try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
          });
        }).on('error', reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function downloadFile(url, destPath) {
  console.log(`  Downloading ${url}`);
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, (redirectRes) => {
          const file = createWriteStream(destPath);
          pipeline(redirectRes, file).then(resolve).catch(reject);
        }).on('error', reject);
        return;
      }
      const file = createWriteStream(destPath);
      pipeline(res, file).then(resolve).catch(reject);
    }).on('error', reject);
  });
}

async function extractTarGz(tarPath, destDir) {
  // Use system tar command (available on Linux/macOS)
  console.log(`  Extracting ${path.basename(tarPath)}...`);
  fs.mkdirSync(destDir, { recursive: true });
  execSync(`tar -xzf "${tarPath}" -C "${destDir}" --strip-components=1`, { stdio: 'pipe' });
}

async function extractZip(zipPath, destDir) {
  // Use unzipper for Windows .zip files
  console.log(`  Extracting ${path.basename(zipPath)}...`);
  fs.mkdirSync(destDir, { recursive: true });
  const zipStream = createReadStream(zipPath).pipe(Extract({ path: destDir }));
  await new Promise((resolve, reject) => {
    zipStream.on('close', resolve);
    zipStream.on('error', reject);
  });
  // The zip from Adoptium has a top-level directory like jdk-21.0.X+Y-jre/
  // Move contents up one level
  const entries = fs.readdirSync(destDir);
  const topDir = entries.find(e => e.startsWith('jdk-') && fs.statSync(path.join(destDir, e)).isDirectory());
  if (topDir) {
    const topPath = path.join(destDir, topDir);
    for (const entry of fs.readdirSync(topPath)) {
      fs.renameSync(path.join(topPath, entry), path.join(destDir, entry));
    }
    fs.rmdirSync(topPath);
  }
}

async function main() {
  const args = parseArgs();
  const os = mapPlatform(args.platform);
  const arch = mapArch(args.arch);

  console.log(`\n=== Bundling JRE for ${os}-${arch} ===`);

  // Check if already bundled
  const javaBin = args.platform === 'win32' ? 'java.exe' : 'java';
  const javaPath = path.join(JRE_DIR, 'bin', javaBin);
  if (fs.existsSync(javaPath) && !args.force) {
    console.log(`JRE already exists at ${javaPath}`);
    console.log('Use --force to re-download.\n');
    return;
  }

  // Clean existing
  if (fs.existsSync(JRE_DIR)) {
    console.log('Removing existing JRE directory...');
    fs.rmSync(JRE_DIR, { recursive: true, force: true });
  }

  // Get the latest Temurin 21 JRE release
  console.log(`Fetching Eclipse Temurin ${JAVA_VERSION} JRE info...`);
  const assetUrl = `${ADOPTIUM_API}/assets/latest/${JAVA_VERSION}/hotspot?architecture=${arch}&image_type=jre&os=${os}&vendor=eclipse`;
  const assets = await fetchJson(assetUrl);
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new Error(`No JRE binary found for ${os}-${arch}. Response: ${JSON.stringify(assets)}`);
  }

  const binary = assets[0].binary;
  console.log(`  Found: ${binary.package.name} (${(binary.package.size / 1024 / 1024).toFixed(0)} MB)`);
  console.log(`  Release: ${assets[0].release_name}`);

  // Download
  const tmpDir = path.join(__dirname, '..', 'tmp-jre');
  fs.mkdirSync(tmpDir, { recursive: true });
  const archiveName = binary.package.name;
  const archivePath = path.join(tmpDir, archiveName);

  try {
    await downloadFile(binary.package.link, archivePath);

    // Extract
    fs.mkdirSync(JRE_DIR, { recursive: true });
    if (archiveName.endsWith('.tar.gz') || archiveName.endsWith('.tgz')) {
      await extractTarGz(archivePath, JRE_DIR);
    } else if (archiveName.endsWith('.zip')) {
      await extractZip(archivePath, JRE_DIR);
    } else {
      throw new Error(`Unknown archive format: ${archiveName}`);
    }

    // Verify
    if (!fs.existsSync(javaPath)) {
      // The extraction may have a nested directory — look for bin/java recursively
      const findJava = (dir, depth = 0) => {
        if (depth > 3) return null;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isFile() && entry.name === javaBin) return fullPath;
          if (entry.isDirectory()) {
            const found = findJava(fullPath, depth + 1);
            if (found) return found;
          }
        }
        return null;
      };
      const foundJava = findJava(JRE_DIR);
      if (foundJava) {
        const foundJreDir = path.dirname(path.dirname(foundJava)); // up from bin/java to jre root
        // Move contents to JRE_DIR
        for (const entry of fs.readdirSync(foundJreDir)) {
          const src = path.join(foundJreDir, entry);
          const dest = path.join(JRE_DIR, entry);
          if (!fs.existsSync(dest)) fs.renameSync(src, dest);
        }
      }
    }

    if (!fs.existsSync(javaPath)) {
      throw new Error(`Java binary not found at ${javaPath} after extraction.`);
    }

    // Make Java executable on Unix
    if (args.platform !== 'win32') {
      fs.chmodSync(javaPath, 0o755);
    }

    // On macOS, strip pre-existing code signatures from the JRE so electron-builder can re-sign cleanly
    if (args.platform === 'darwin') {
      console.log('  Stripping pre-existing code signatures from JRE (macOS)...');
      try {
        execSync(`find "${JRE_DIR}" -type f \\( -perm +111 -o -name "*.dylib" -o -name "*.jnilib" \\) -exec codesign --remove-signature {} \\; 2>/dev/null || true`, { stdio: 'pipe' });
        execSync(`codesign --remove-signature "${JRE_DIR}" 2>/dev/null || true`, { stdio: 'pipe' });
        console.log('  Code signatures stripped.');
      } catch (stripErr) {
        console.warn(`  Could not strip some signatures (non-fatal): ${stripErr.message}`);
      }
    }

    console.log(`\n✓ JRE bundled successfully at ${javaPath}`);
    console.log('');

    // Verify version
    try {
      const versionOutput = execSync(`"${javaPath}" -version 2>&1`, { encoding: 'utf-8', timeout: 10000 });
      console.log(`  ${versionOutput.split('\n')[0]}`);
    } catch (e) {
      console.warn(`  Could not verify Java version: ${e.message}`);
    }
  } finally {
    // Cleanup temp
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error(`\n✗ Failed to bundle JRE: ${err.message}`);
  process.exit(1);
});
