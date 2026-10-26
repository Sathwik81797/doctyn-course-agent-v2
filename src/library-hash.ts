/**
 * npm run library:hash-password -- you@example.com
 *
 * Prints one LIBRARY_USERS entry (email=scrypt hash) for the private video library. Only the hash is ever stored
 * in the environment, never the password. Provide the password without it appearing in your shell history:
 *   read -s -p "Password: " LIBRARY_PASSWORD; export LIBRARY_PASSWORD; npm run library:hash-password -- you@example.com
 * (or pipe it: printf '%s' "$PW" | npm run library:hash-password -- you@example.com --stdin)
 * Join several entries with commas to invite several people.
 */
import { cleanEmail, cleanPassword, hashPassword } from "../cloud/auth.js";

const args = process.argv.slice(2);
const emailArg = args.find((a) => !a.startsWith("--"));
if (!emailArg) {
  console.error("Usage: npm run library:hash-password -- you@example.com   (password from $LIBRARY_PASSWORD or --stdin)");
  process.exit(2);
}
let password = process.env.LIBRARY_PASSWORD ?? "";
if (args.includes("--stdin")) {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  password = data.replace(/\r?\n$/, "");
}
if (!password) {
  console.error("No password given. Set LIBRARY_PASSWORD or use --stdin.");
  process.exit(2);
}
try {
  console.log(`${cleanEmail(emailArg)}=${await hashPassword(cleanPassword(password))}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
