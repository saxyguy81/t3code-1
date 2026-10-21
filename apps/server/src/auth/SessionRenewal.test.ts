import * as NodeServices from "@effect/platform-node/NodeServices";
import { type AuthSessionId, AuthStandardClientScopes, EnvironmentId } from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import type { AuthSessionRepositoryError } from "../persistence/Errors.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SessionStore from "./SessionStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const layerSessionStore = SessionStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-renewal-test-" })),
);
const layerTest = Layer.merge(layerSessionStore, TestClock.layer());

// Runs another writer's change just before the next renewal UPDATE, so that
// renewal loses its optimistic check the way a concurrent request would.
const race: {
  before?:
    | ((
        repository: AuthSessions.AuthSessionRepository["Service"],
        input: AuthSessions.RenewAuthSessionInput,
      ) => Effect.Effect<unknown, AuthSessionRepositoryError>)
    | undefined;
} = {};
const layerRacingRepository = Layer.effect(
  AuthSessions.AuthSessionRepository,
  Effect.gen(function* () {
    const repository = yield* AuthSessions.AuthSessionRepository;
    return AuthSessions.AuthSessionRepository.of({
      ...repository,
      renew: (input) => {
        const before = race.before;
        race.before = undefined;
        return (before ? before(repository, input) : Effect.void).pipe(
          Effect.andThen(repository.renew(input)),
        );
      },
    });
  }),
).pipe(Layer.provide(AuthSessions.layer));
const layerRacingTest = Layer.merge(
  Layer.effect(SessionStore.SessionStore, SessionStore.make).pipe(
    Layer.provideMerge(layerRacingRepository),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
      }),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-renewal-race-" })),
  ),
  TestClock.layer(),
);

// The row a phone gets from pairing: a bearer token exchanged for a one-time code.
const phoneSession = {
  method: "bearer-access-token",
  subject: "one-time-token",
  scopes: AuthStandardClientScopes,
  client: { label: "iPhone", deviceType: "mobile", os: "iOS" },
} as const;

const renewOrFail = (sessions: SessionStore.SessionStore["Service"], token: string) =>
  sessions
    .renew(token)
    .pipe(
      Effect.flatMap((renewal) =>
        renewal.renewed
          ? Effect.succeed(renewal.session)
          : Effect.die(new Error(`expected a renewal, got ${renewal.reason}`)),
      ),
    );

const watchInvalidation = (
  sessions: SessionStore.SessionStore["Service"],
  sessionId: AuthSessionId,
) =>
  Effect.gen(function* () {
    const invalidated = yield* Deferred.make<void>();
    const fiber = yield* sessions
      .awaitInvalidation(sessionId)
      .pipe(
        Effect.andThen(Deferred.succeed(invalidated, undefined)),
        Effect.forkScoped({ startImmediately: true }),
      );
    return { invalidated, fiber };
  });

it.layer(NodeServices.layer)("SessionStore renewal", (it) => {
  it.effect("(a) renews a phone bearer session in place, with a later expiry", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue(phoneSession);

      yield* TestClock.adjust(Duration.days(29));
      const renewed = yield* renewOrFail(sessions, issued.token);

      expect(renewed.sessionId).toBe(issued.sessionId);
      expect(renewed.token).not.toBe(issued.token);
      expect(renewed.expiresAt.epochMilliseconds).toBeGreaterThan(
        issued.expiresAt.epochMilliseconds,
      );
      expect(renewed.method).toBe("bearer-access-token");
      expect(renewed.scopes).toEqual(issued.scopes);

      // The renewed token outlives the original deadline, and listings show it.
      yield* TestClock.adjust(Duration.days(2));
      const verified = yield* sessions.verify(renewed.token);
      expect(verified.sessionId).toBe(issued.sessionId);
      expect(verified.subject).toBe("one-time-token");
      const listed = yield* sessions.listActive();
      expect(listed.map((session) => session.sessionId)).toEqual([issued.sessionId]);
      expect(listed[0]?.expiresAt.epochMilliseconds).toBe(renewed.expiresAt.epochMilliseconds);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("(c) keeps a connected socket open past its original expiry once renewed", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue(phoneSession);
      yield* sessions.markConnected(issued.sessionId);
      const { invalidated, fiber } = yield* watchInvalidation(sessions, issued.sessionId);

      yield* TestClock.adjust(Duration.days(29));
      const renewed = yield* renewOrFail(sessions, issued.token);

      yield* TestClock.adjust(Duration.days(2));
      expect(yield* Deferred.isDone(invalidated)).toBe(false);
      const ticket = yield* sessions.issueWebSocketToken(issued.sessionId);
      expect((yield* sessions.verifyWebSocketToken(ticket.token)).sessionId).toBe(issued.sessionId);

      // It still ends at the renewed deadline.
      yield* TestClock.adjust(
        Duration.millis(renewed.expiresAt.epochMilliseconds - issued.expiresAt.epochMilliseconds),
      );
      yield* Fiber.join(fiber);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "(d) revoking a renewed session rejects old and new tokens at once and drops the socket",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const issued = yield* sessions.issue(phoneSession);
        yield* sessions.markConnected(issued.sessionId);
        const { fiber } = yield* watchInvalidation(sessions, issued.sessionId);

        yield* TestClock.adjust(Duration.days(29));
        const renewed = yield* renewOrFail(sessions, issued.token);
        // Inside the grace window the old token still works...
        yield* sessions.verify(issued.token);

        expect(yield* sessions.revoke(issued.sessionId)).toBe(true);

        // ...but a revoke ends both at once, and the socket.
        yield* Fiber.join(fiber);
        for (const token of [issued.token, renewed.token]) {
          expect((yield* Effect.flip(sessions.verify(token)))._tag).toBe(
            "SessionTokenRevokedError",
          );
          expect((yield* Effect.flip(sessions.renew(token)))._tag).toBe("SessionTokenRevokedError");
        }
        expect(yield* sessions.listActive()).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("(e) never renews past 180 days from the original issue time", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue(phoneSession);
      const issuedAtMs = issued.expiresAt.epochMilliseconds - Duration.toMillis(Duration.days(30));
      const capMs = issuedAtMs + Duration.toMillis(Duration.days(180));

      let token = issued.token;
      let expiresAtMs = issued.expiresAt.epochMilliseconds;
      let renewals = 0;
      let refusal: SessionStore.SessionRenewal | undefined;
      while (refusal === undefined && renewals < 20) {
        // One day before each deadline, as a phone opened daily would.
        const now = yield* Clock.currentTimeMillis;
        yield* TestClock.adjust(
          Duration.millis(expiresAtMs - now - Duration.toMillis(Duration.days(1))),
        );
        const renewal = yield* sessions.renew(token);
        if (!renewal.renewed) {
          refusal = renewal;
          break;
        }
        renewals += 1;
        expect(renewal.session.sessionId).toBe(issued.sessionId);
        expect(renewal.session.expiresAt.epochMilliseconds).toBeLessThanOrEqual(capMs);
        expect(renewal.session.expiresAt.epochMilliseconds).toBeGreaterThan(expiresAtMs);
        token = renewal.session.token;
        expiresAtMs = renewal.session.expiresAt.epochMilliseconds;
      }

      assert(refusal !== undefined && !refusal.renewed);
      expect(refusal.reason).toBe("max_lifetime");
      expect(renewals).toBeGreaterThan(1);
      expect(expiresAtMs).toBe(capMs);

      // At the cap the session ends like any other.
      const now = yield* Clock.currentTimeMillis;
      yield* TestClock.adjust(Duration.millis(capMs - now));
      expect((yield* Effect.flip(sessions.verify(token)))._tag).toBe("SessionTokenExpiredError");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("(f) the replaced token works for a 10-minute grace window, then fails", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue(phoneSession);

      yield* TestClock.adjust(Duration.days(29));
      const renewed = yield* renewOrFail(sessions, issued.token);

      expect((yield* sessions.verify(issued.token)).sessionId).toBe(issued.sessionId);
      // A client that lost the renewal's answer gets the same session back,
      // not a second extension.
      const redelivered = yield* renewOrFail(sessions, issued.token);
      expect(redelivered.sessionId).toBe(issued.sessionId);
      expect(redelivered.expiresAt.epochMilliseconds).toBe(renewed.expiresAt.epochMilliseconds);

      yield* TestClock.adjust(Duration.seconds(9 * 60 + 59));
      yield* sessions.verify(issued.token);

      yield* TestClock.adjust(Duration.seconds(1));
      expect((yield* Effect.flip(sessions.verify(issued.token)))._tag).toBe(
        "SessionTokenSupersededError",
      );
      expect((yield* Effect.flip(sessions.renew(issued.token)))._tag).toBe(
        "SessionTokenSupersededError",
      );
      expect((yield* sessions.verify(renewed.token)).sessionId).toBe(issued.sessionId);
      expect((yield* sessions.verify(redelivered.token)).sessionId).toBe(issued.sessionId);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("(g) renews only a token in active use, never an idle one past its TTL", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;

      // Early renewal changes nothing: the token must be near expiry.
      const active = yield* sessions.issue(phoneSession);
      yield* TestClock.adjust(Duration.days(1));
      const early = yield* sessions.renew(active.token);
      assert(!early.renewed);
      expect(early.reason).toBe("not_due");
      expect(early.expiresAt.epochMilliseconds).toBe(active.expiresAt.epochMilliseconds);

      // A token nobody used before its TTL ran out cannot be brought back.
      const idle = yield* sessions.issue(phoneSession);
      yield* TestClock.adjust(Duration.days(30));
      expect((yield* Effect.flip(sessions.renew(idle.token)))._tag).toBe(
        "SessionTokenExpiredError",
      );
      expect((yield* Effect.flip(sessions.verify(idle.token)))._tag).toBe(
        "SessionTokenExpiredError",
      );
      expect(
        (yield* sessions.listActive()).some((session) => session.sessionId === idle.sessionId),
      ).toBe(false);

      // Proof-bound T3 Connect tokens re-exchange; they never renew here.
      const relay = yield* sessions.issue({
        subject: "managed-relay-bootstrap",
        method: "dpop-access-token",
        proofKeyThumbprint: "relay-proof-key",
        ttl: Duration.hours(1),
      });
      yield* TestClock.adjust(Duration.minutes(59));
      const relayRenewal = yield* sessions.renew(relay.token);
      assert(!relayRenewal.renewed);
      expect(relayRenewal.reason).toBe("not_renewable");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a renewal that loses the race hands out the winner's token, never a second extension", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue(phoneSession);
      yield* TestClock.adjust(Duration.days(29));

      let winnerExpiresAtMs: number | undefined;
      race.before = (repository, input) => {
        winnerExpiresAtMs = input.expiresAt.epochMilliseconds;
        return repository.renew(input);
      };
      const loser = yield* renewOrFail(sessions, issued.token);
      expect(race.before).toBeUndefined();
      expect(loser.sessionId).toBe(issued.sessionId);
      expect(loser.expiresAt.epochMilliseconds).toBe(winnerExpiresAtMs);
      expect((yield* sessions.verify(loser.token)).sessionId).toBe(issued.sessionId);
      const [listed] = yield* sessions.listActive();
      expect(listed?.expiresAt.epochMilliseconds).toBe(winnerExpiresAtMs);
    }).pipe(Effect.provide(layerRacingTest)),
  );

  it.effect("a renewal that loses to a revoke fails as revoked", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue(phoneSession);
      yield* TestClock.adjust(Duration.days(29));

      race.before = (repository, input) =>
        repository.revoke({ sessionId: input.sessionId, revokedAt: input.renewedAt });
      expect((yield* Effect.flip(sessions.renew(issued.token)))._tag).toBe(
        "SessionTokenRevokedError",
      );
      expect(yield* sessions.listActive()).toEqual([]);
    }).pipe(Effect.provide(layerRacingTest)),
  );

  it.effect("after two renewals only the token replaced last gets the grace window", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const repository = yield* AuthSessions.AuthSessionRepository;
      const issued = yield* sessions.issue(phoneSession);
      yield* TestClock.adjust(Duration.days(29));
      const second = yield* renewOrFail(sessions, issued.token);

      // A second renewal lands a minute later (as one under a shorter
      // lifetime could), while the first token has not expired by its own claim.
      yield* TestClock.adjust(Duration.minutes(1));
      const row = yield* repository.getById({ sessionId: issued.sessionId });
      assert(row._tag === "Some");
      const now = yield* Clock.currentTimeMillis;
      expect(
        yield* repository.renew({
          sessionId: issued.sessionId,
          previousExpiresAt: row.value.expiresAt,
          previousRenewedAt: row.value.renewedAt,
          expiresAt: DateTime.makeUnsafe(row.value.expiresAt.epochMilliseconds + 60_000),
          renewedAt: DateTime.makeUnsafe(now),
        }),
      ).toBe(true);

      expect((yield* Effect.flip(sessions.verify(issued.token)))._tag).toBe(
        "SessionTokenSupersededError",
      );
      expect((yield* Effect.flip(sessions.renew(issued.token)))._tag).toBe(
        "SessionTokenSupersededError",
      );
      expect((yield* sessions.verify(second.token)).sessionId).toBe(issued.sessionId);
    }).pipe(Effect.provide(layerTest)),
  );
});
