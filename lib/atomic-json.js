import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ATOMIC_TMP_DIR = path.join(__dirname, "..", "tmp");

export function saveJsonAtomic(file, data) {
  const suffix = `${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}`;
  fs.mkdirSync(ATOMIC_TMP_DIR, { recursive: true });
  const base = path.basename(file);
  const tmp = path.join(ATOMIC_TMP_DIR, `${base}.${suffix}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}
