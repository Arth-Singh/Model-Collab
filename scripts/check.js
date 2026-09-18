import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

for (const directory of ['bin', 'src']) {
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', path.join(directory, name)], {
      stdio: 'inherit',
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
