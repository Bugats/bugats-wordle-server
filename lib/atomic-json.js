import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ATOMIC_TMP_DIR = path.join(__dirname, "..", "tmp");

/**
 * Pārcelt pagaidu failu uz galīgo ceļu. Starp atšķirīgām ierīcēm (piem. Render
 * `src/tmp/` un persistent `/var/data/`) `rename` met EXDEV — tad copy+unlink.
 */
function moveOntoFile(tmp, destFile) {
  try {
    fs.renameSync(tmp, destFile);
  } catch (e) {
    if (e && (e.code === "EXDEV" || e.code === "ENOTSUP")) {
      fs.copyFileSync(tmp, destFile);
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* jau pārrakstīts vai nav */
      }
    } else {
      throw e;
    }
  }
}

export function saveJsonAtomic(file, data) {
  const suffix = `${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}`;
  fs.mkdirSync(ATOMIC_TMP_DIR, { recursive: true });
  const base = path.basename(file);
  const tmp = path.join(ATOMIC_TMP_DIR, `${base}.${suffix}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  const dir = path.dirname(file);
  if (dir) fs.mkdirSync(dir, { recursive: true });
  moveOntoFile(tmp, file);
}
