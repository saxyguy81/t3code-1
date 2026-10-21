import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as AuthHttp from "./http.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

// Real time plus an offset the test moves forward, so a session can be
// issued now and presented 29 days later through the real HTTP routes.
const clockOffset = { ms: 0 };
const baseClock = Clock.Clock.defaultValue();
const shiftedNanos = () => baseClock.currentTimeNanosUnsafe() + BigInt(clockOffset.ms) * 1_000_000n;
const shiftedClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => baseClock.currentTimeMillisUnsafe() + clockOffset.ms,
  currentTimeMillis: Effect.sync(() => baseClock.currentTimeMillisUnsafe() + clockOffset.ms),
  currentTimeNanosUnsafe: shiftedNanos,
  currentTimeNanos: Effect.sync(shiftedNanos),
  monotonicTimeNanosUnsafe: () => baseClock.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: baseClock.monotonicTimeNanos,
  sleep: (duration) => baseClock.sleep(duration),
};

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-renew-http-" })));

const layerRoutes = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(AuthHttp.layer),
  Layer.provide(AuthHttp.layerAuthenticatedAuth),
  Layer.provideMerge(
    EnvironmentAuth.layer.pipe(
      Layer.provide(SqlitePersistence.layerMemory),
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(ServerEnvironment.layerIdentity),
      Layer.provide(layerConfig),
    ),
  ),
  Layer.provide(layerConfig),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(NodeServices.layer),
  Layer.provideMerge(Layer.succeed(Clock.Clock, shiftedClock)),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

const postEmpty = (path: string, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, { method: "POST", ...(headers ? { headers } : {}) });

const cookieExpiresMs = (setCookie: string | undefined) => {
  const expires = setCookie?.match(/Expires=([^;]+)/i)?.[1];
  return expires === undefined ? Number.NaN : Date.parse(expires);
};

const withRoutes = <A>(
  use: (
    handler: (request: Request) => Promise<Response>,
    issueCredential: () => Promise<string>,
  ) => Promise<A>,
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        clockOffset.ms = 0;
        return HttpRouter.toWebHandler(layerRoutes, { disableLogger: true });
      }),
      (web) =>
        Effect.tryPromise(async () => {
          const handler = (request: Request) => web.handler(request, requestContext);
          const devResponse = await handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
          );
          const devCookie =
            devResponse.headers
              .getSetCookie()
              .find((cookie) => cookie.startsWith("t3_dev_session_"))
              ?.split(";", 1)[0] ?? "";
          // The one-time code a phone scans; each use pairs a new client.
          const issueCredential = async () => {
            const response = await handler(
              postJson("/api/auth/pairing-token", {}, { cookie: devCookie }),
            );
            expect(response.status).toBe(200);
            return ((await response.json()) as { credential: string }).credential;
          };
          return await use(handler, issueCredential);
        }),
      (web) =>
        Effect.promise(() => web.dispose()).pipe(
          Effect.ensuring(Effect.sync(() => (clockOffset.ms = 0))),
        ),
    );
  }).pipe(Effect.provide(NodeServices.layer));

it.effect("(b) GET /api/auth/session refreshes a cookie near expiry with a later one", () =>
  withRoutes(async (handler, issueCredential) => {
    const created = await handler(
      postJson("/api/auth/browser-session", { credential: await issueCredential() }),
    );
    expect(created.status).toBe(200);
    const [originalCookie] = created.headers.getSetCookie();
    expect(originalCookie).toMatch(/^t3_session_/);
    const cookie = originalCookie?.split(";", 1)[0] ?? "";
    const originalExpiresMs = cookieExpiresMs(originalCookie);

    // A fresh session is left alone.
    const fresh = await handler(
      new Request("http://127.0.0.1/api/auth/session", { headers: { cookie } }),
    );
    expect(await fresh.json()).toMatchObject({ authenticated: true });
    expect(fresh.headers.getSetCookie()).toEqual([]);

    clockOffset.ms = Duration.toMillis(Duration.days(29));
    const nearExpiry = await handler(
      new Request("http://127.0.0.1/api/auth/session", { headers: { cookie } }),
    );
    expect(nearExpiry.status).toBe(200);
    const state = (await nearExpiry.json()) as { authenticated: boolean; expiresAt: string };
    expect(state.authenticated).toBe(true);
    const [renewedCookie] = nearExpiry.headers.getSetCookie();
    expect(renewedCookie).toMatch(/^t3_session_/);
    expect(renewedCookie).toContain("HttpOnly");
    expect(cookieExpiresMs(renewedCookie)).toBeGreaterThan(originalExpiresMs);
    expect(Date.parse(state.expiresAt)).toBeGreaterThan(originalExpiresMs);
    expect(nearExpiry.headers.get("cache-control")).toBe("no-store");

    // The refreshed cookie outlives the original deadline.
    clockOffset.ms = Duration.toMillis(Duration.days(31));
    const later = await handler(
      new Request("http://127.0.0.1/api/auth/session", {
        headers: { cookie: renewedCookie?.split(";", 1)[0] ?? "" },
      }),
    );
    expect(await later.json()).toMatchObject({ authenticated: true });
  }),
);

it.effect("POST /api/auth/session/renew gives a phone bearer client a later token", () =>
  withRoutes(async (handler, issueCredential) => {
    const exchanged = await handler(
      new Request("http://127.0.0.1/oauth/token", {
        method: "POST",
        headers: { "user-agent": "T3Code/1 CFNetwork Darwin iPhone" },
        body: new URLSearchParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: await issueCredential(),
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
          client_label: "iPhone",
          client_device_type: "mobile",
          client_os: "iOS",
        }),
      }),
    );
    expect(exchanged.status).toBe(200);
    const access = (await exchanged.json()) as { access_token: string };
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
    const sessionState = async (token: string) =>
      (await (
        await handler(new Request("http://127.0.0.1/api/auth/session", { headers: bearer(token) }))
      ).json()) as { authenticated: boolean; expiresAt?: string };
    const originalExpiresMs = Date.parse((await sessionState(access.access_token)).expiresAt ?? "");

    const early = await handler(postEmpty("/api/auth/session/renew", bearer(access.access_token)));
    expect(early.status).toBe(200);
    expect(await early.json()).toMatchObject({ renewed: false, reason: "not_due" });

    clockOffset.ms = Duration.toMillis(Duration.days(29));
    const renewedResponse = await handler(
      postEmpty("/api/auth/session/renew", bearer(access.access_token)),
    );
    expect(renewedResponse.status).toBe(200);
    expect(renewedResponse.headers.getSetCookie()).toEqual([]);
    const renewed = (await renewedResponse.json()) as {
      renewed: boolean;
      expiresAt: string;
      access_token: string;
    };
    expect(renewed.renewed).toBe(true);
    expect(renewed.access_token).not.toBe(access.access_token);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(originalExpiresMs);

    // Both work during the grace window; only the new one after it.
    expect(await sessionState(access.access_token)).toMatchObject({ authenticated: true });
    expect(await sessionState(renewed.access_token)).toMatchObject({ authenticated: true });
    clockOffset.ms += Duration.toMillis(Duration.minutes(11));
    expect(await sessionState(access.access_token)).toMatchObject({ authenticated: false });
    clockOffset.ms = Duration.toMillis(Duration.days(31));
    expect(await sessionState(renewed.access_token)).toMatchObject({ authenticated: true });

    const unauthenticated = await handler(postEmpty("/api/auth/session/renew"));
    expect(unauthenticated.status).toBe(401);
  }),
);
