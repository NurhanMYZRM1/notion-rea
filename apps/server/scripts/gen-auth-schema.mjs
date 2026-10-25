// Prints the SQL Better Auth needs for our config (run after upgrading better-auth; paste into a new migration).
import { DatabaseSync } from "node:sqlite";
import { expo } from "@better-auth/expo";
import { getMigrations } from "better-auth/db/migration";

const { compileMigrations } = await getMigrations({
  database: new DatabaseSync(":memory:"),
  emailAndPassword: { enabled: true },
  plugins: [expo()],
});
console.log(await compileMigrations());
