// @ts-check
// npm run cloud:create-admin -- <email> "<name>"   (password is read from ADMIN_PASSWORD or prompted-free env)
// Creates or promotes an administrator directly in the configured database.
import "dotenv/config";
import { hashPassword, cleanEmail, cleanPassword } from "./auth.js";
import { getContext } from "./context.js";

const [emailArg, nameArg] = process.argv.slice(2);
const password = process.env.ADMIN_PASSWORD;
if (!emailArg || !password) {
  console.error('Usage: ADMIN_PASSWORD="a long password" npm run cloud:create-admin -- admin@example.com "Admin Name"');
  process.exit(2);
}
const ctx = await getContext();
const email = cleanEmail(emailArg);
const hash = await hashPassword(cleanPassword(password));
await ctx.db.query(
  `INSERT INTO users(email, name, password_hash, role, status) VALUES ($1,$2,$3,'admin','active')
   ON CONFLICT (email) DO UPDATE SET role = 'admin', status = 'active', password_hash = EXCLUDED.password_hash`,
  [email, nameArg || "Administrator", hash],
);
console.log(`Administrator ready: ${email}`);
await ctx.db.close();
