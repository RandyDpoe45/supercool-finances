// 10-app-user.js — create the analytics read-model database and its app user.
//
// Runs ONCE, on an empty data dir, via the official image's
// /docker-entrypoint-initdb.d hook, authenticated as the root user
// (MONGO_INITDB_ROOT_USERNAME/PASSWORD). The app user gets readWrite on the
// `analytics` database ONLY — never on admin or any other database, so the
// analytics server cannot reach outside its own store. Credentials come from the
// container environment (compose injects them from .env); nothing is hardcoded.
const dbName = process.env.MONGO_DB || 'analytics';
const appUser = process.env.MONGO_APP_USER;
const appPwd = process.env.MONGO_APP_PASSWORD;

const analyticsDb = db.getSiblingDB(dbName);
analyticsDb.createUser({
  user: appUser,
  pwd: appPwd,
  roles: [{ role: 'readWrite', db: dbName }],
});

print(`[init] created app user '${appUser}' with readWrite on '${dbName}' only`);
