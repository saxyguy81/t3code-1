import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A renewed session keeps its id and moves `expires_at` forward. The token it
// replaced stays valid for a short grace window, so the row records when the
// renewal happened and the expiry that token carried.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;

  if (!columns.some((column) => column.name === "renewed_at")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN renewed_at TEXT
    `;
  }

  if (!columns.some((column) => column.name === "previous_expires_at")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN previous_expires_at TEXT
    `;
  }
});
