import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ConnectionResolver from "./resolver.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  SshConnectionProfile,
  type ConnectionCredential,
  type ConnectionProfile,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import {
  BearerConnectionTarget,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  SshConnectionTarget,
  type ConnectionTarget,
} from "./model.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import * as RpcHttp from "../rpc/http.ts";
import {
  GitHubRoutingPermissions,
  gitHubRoutingConnectionKey,
  makeGitHubRoutingPermissions,
} from "./githubRoutingPermissions.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const ENDPOINT = {
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
};
const SSH_TARGET: DesktopSshEnvironmentTarget = {
  alias: "development",
  hostname: "development.example.test",
  username: "developer",
  port: 22,
};

function catalogEntry(
  target: ConnectionTarget,
  profile: Option.Option<ConnectionProfile> = Option.none(),
): ConnectionCatalogEntry {
  return { target, profile, enabled: true };
}

const makeDependencies = Effect.fn("TestConnectionResolver.makeDependencies")((options?: {
  readonly profiles?: ReadonlyArray<ConnectionProfile>;
  readonly profileStore?: ConnectionProfileStore.ConnectionProfileStore["Service"];
  readonly credentials?: ReadonlyArray<readonly [string, ConnectionCredential]>;
  readonly authorizeBearer?: RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]["authorizeBearer"];
  readonly authorizeDpop?: RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]["authorizeDpop"];
  readonly primaryBearerToken?: string;
  readonly prepareSsh?: ClientCapabilities.SshEnvironmentGateway["Service"]["prepare"];
  readonly descriptorProtocolVersion?: number | null | undefined;
  readonly renewSession?: (request: Request) => Response;
  readonly onCredentialPut?: (connectionId: string, credential: ConnectionCredential) => void;
  readonly failCredentialPut?: () => boolean;
}) => {
  const profiles = new Map(
    (options?.profiles ?? []).map((profile) => [profile.connectionId, profile]),
  );
  const credentials = new Map(options?.credentials ?? []);

  const profileStore = ConnectionProfileStore.ConnectionProfileStore.of({
    get: (connectionId) => Effect.succeed(Option.fromNullishOr(profiles.get(connectionId))),
    put: (profile) => Effect.sync(() => void profiles.set(profile.connectionId, profile)),
    remove: (connectionId) => Effect.sync(() => void profiles.delete(connectionId)),
  });
  const credentialStore = ConnectionCredentialStore.ConnectionCredentialStore.of({
    get: (connectionId) => Effect.succeed(Option.fromNullishOr(credentials.get(connectionId))),
    put: (connectionId, credential) =>
      options?.failCredentialPut?.()
        ? Effect.fail(
            new ConnectionTransientError({ reason: "transport", detail: "keychain is locked" }),
          )
        : Effect.sync(() => {
            options?.onCredentialPut?.(connectionId, credential);
            credentials.set(connectionId, credential);
          }),
    remove: (connectionId) => Effect.sync(() => void credentials.delete(connectionId)),
  });
  const remote = RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
    authorizeBearer:
      options?.authorizeBearer ??
      ((input) =>
        Effect.succeed({
          environmentId: input.expectedEnvironmentId,
          label: "Authorized bearer environment",
          httpBaseUrl: input.httpBaseUrl,
          socketUrl: "wss://authorized.example.test/ws?wsTicket=bearer",
          httpAuthorization: {
            _tag: "Bearer" as const,
            token: input.bearerToken,
          },
        })),
    authorizeDpop:
      options?.authorizeDpop ??
      ((input) =>
        Effect.succeed({
          environmentId: input.expectedEnvironmentId,
          label: "Authorized relay environment",
          httpBaseUrl: ENDPOINT.httpBaseUrl,
          socketUrl: "wss://authorized.example.test/ws?wsTicket=dpop",
          httpAuthorization: {
            _tag: "Dpop" as const,
            accessToken: "dpop-access-token",
            expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
          },
        })),
    authorizeDpopHttp: () => Effect.die("unused"),
  });
  const ssh = ClientCapabilities.SshEnvironmentGateway.of({
    provision: () => Effect.die("unused"),
    prepare:
      options?.prepareSsh ??
      (() =>
        Effect.succeed({
          bootstrap: {
            target: SSH_TARGET,
            httpBaseUrl: "http://127.0.0.1:4010",
            wsBaseUrl: "ws://127.0.0.1:4010",
            pairingToken: null,
          },
          bearerToken: "ssh-bearer",
        })),
    disconnect: () => Effect.void,
  });

  const layerDependencies = Layer.mergeAll(
    RpcHttp.layerRemoteHttpClient(((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/api/auth/session/renew") {
        return Promise.resolve(
          options?.renewSession?.(request) ??
            Response.json({ code: "not_found", reason: "not_found" }, { status: 404 }),
        );
      }
      return Promise.resolve(
        Response.json({
          environmentId: ENVIRONMENT_ID,
          label: "Compatible environment",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0-test",
          ...(options?.descriptorProtocolVersion === undefined
            ? { orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION }
            : options.descriptorProtocolVersion === null
              ? {}
              : { orchestrationProtocolVersion: options.descriptorProtocolVersion }),
          capabilities: { repositoryIdentity: true },
        }),
      );
    }) satisfies typeof fetch),
    Layer.succeed(
      ConnectionProfileStore.ConnectionProfileStore,
      options?.profileStore ?? profileStore,
    ),
    Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, credentialStore),
    Layer.succeed(
      ClientCapabilities.PrimaryEnvironmentAuth,
      ClientCapabilities.PrimaryEnvironmentAuth.of({
        bearerToken: Effect.succeed(Option.fromNullishOr(options?.primaryBearerToken)),
      }),
    ),
    Layer.succeed(
      ClientCapabilities.ClientPresentation,
      ClientCapabilities.ClientPresentation.of({
        metadata: { label: "Test Client", deviceType: "desktop", surface: "web" },
      }),
    ),
    Layer.succeed(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, remote),
    Layer.succeed(ClientCapabilities.SshEnvironmentGateway, ssh),
  );

  return Effect.succeed(ConnectionResolver.layer.pipe(Layer.provide(layerDependencies)));
});

describe("ConnectionResolver", () => {
  it.effect("blocks an old host during discovery before opening orchestration RPC", () =>
    Effect.gen(function* () {
      const layerBroker = yield* makeDependencies({ descriptorProtocolVersion: null });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));
      const target = new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        wsBaseUrl: "ws://127.0.0.1:3777",
      });

      const error = yield* Effect.flip(broker.prepare(catalogEntry(target)));

      expect(error).toMatchObject({ reason: "unsupported" });
      expect(error.message).toContain("Update T3 Code on Compatible environment");
    }),
  );

  it.effect("prepares a primary environment without remote capabilities", () =>
    Effect.gen(function* () {
      const layerBroker = yield* makeDependencies();
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));
      const target = new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        wsBaseUrl: "ws://127.0.0.1:3777",
      });

      expect(yield* broker.prepare(catalogEntry(target))).toEqual({
        environmentId: ENVIRONMENT_ID,
        label: "Primary",
        httpBaseUrl: "http://127.0.0.1:3777",
        socketUrl:
          "ws://127.0.0.1:3777/ws?clientSurface=web&clientDeviceType=desktop&connectionMethod=direct&orchestrationProtocol=2",
        httpAuthorization: null,
        target,
      });
    }),
  );

  it.effect("renews a saved bearer session on connect and stores the token before using it", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const renewAuthorizations: Array<string | null> = [];
      const target = new BearerConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Phone",
        connectionId: "saved-1",
      });
      const profile = new BearerConnectionProfile({
        connectionId: "saved-1",
        environmentId: ENVIRONMENT_ID,
        label: "Phone",
        httpBaseUrl: ENDPOINT.httpBaseUrl,
        wsBaseUrl: ENDPOINT.wsBaseUrl,
      });
      let renewal: Record<string, unknown> = {
        renewed: true,
        expiresAt: "2026-12-20T00:00:00.000Z",
        access_token: "renewed-bearer",
      };
      const layerBroker = yield* makeDependencies({
        credentials: [["saved-1", new BearerConnectionCredential({ token: "old-bearer" })]],
        renewSession: (request) => {
          renewAuthorizations.push(request.headers.get("authorization"));
          return Response.json(renewal);
        },
        onCredentialPut: (connectionId, credential) =>
          events.push(`put:${connectionId}:${credential.token}`),
        authorizeBearer: (input) =>
          Effect.sync(() => events.push(`authorize:${input.bearerToken}`)).pipe(
            Effect.as({
              environmentId: input.expectedEnvironmentId,
              label: "Phone",
              httpBaseUrl: input.httpBaseUrl,
              socketUrl: "wss://environment.example.test/ws?wsTicket=ticket",
              httpAuthorization: { _tag: "Bearer" as const, token: input.bearerToken },
            }),
          ),
      });
      const resolver = yield* ConnectionResolver.ConnectionResolver.pipe(
        Effect.provide(layerBroker),
      );
      const entry = catalogEntry(target, Option.some(profile));

      const prepared = yield* resolver.prepare(entry);
      expect(renewAuthorizations).toEqual(["Bearer old-bearer"]);
      expect(events).toEqual(["put:saved-1:renewed-bearer", "authorize:renewed-bearer"]);
      expect(prepared.httpAuthorization).toEqual({ _tag: "Bearer", token: "renewed-bearer" });

      // Reconnects and route checks within the hour do not ask again.
      yield* resolver.prepare(entry);
      expect(renewAuthorizations).toHaveLength(1);

      // A live connection renews on its daily check, keeping the token when
      // the server says it is not due.
      renewal = { renewed: false, reason: "not_due", expiresAt: "2026-12-20T00:00:00.000Z" };
      yield* TestClock.adjust("2 hours");
      expect(yield* resolver.renewCredential(prepared)).toEqual(Option.none());
      expect(renewAuthorizations).toEqual(["Bearer old-bearer", "Bearer renewed-bearer"]);

      renewal = {
        renewed: true,
        expiresAt: "2027-01-19T00:00:00.000Z",
        access_token: "renewed-again",
      };
      yield* TestClock.adjust("2 hours");
      const renewedLive = yield* resolver.renewCredential(prepared);
      expect(Option.map(renewedLive, (value) => value.httpAuthorization)).toEqual(
        Option.some({ _tag: "Bearer", token: "renewed-again" }),
      );
      expect(events.at(-1)).toBe("put:saved-1:renewed-again");

      // A failed renewal never blocks the connection.
      renewal = {};
      yield* TestClock.adjust("2 hours");
      const failing = yield* resolver.prepare(entry).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      const afterFailure = yield* Fiber.join(failing);
      expect(afterFailure.httpAuthorization).toEqual({ _tag: "Bearer", token: "renewed-again" });
    }),
  );

  // A lost answer must be retried inside the server's 10-minute grace
  // window, not an hour or a day later.
  it.effect("retries a renewal whose answer was lost and stores the re-delivered token", () =>
    Effect.gen(function* () {
      const renewCalls: Array<string | null> = [];
      const authorized: Array<string> = [];
      const stored: Array<string> = [];
      const target = new BearerConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Phone",
        connectionId: "saved-1",
      });
      const profile = new BearerConnectionProfile({
        connectionId: "saved-1",
        environmentId: ENVIRONMENT_ID,
        label: "Phone",
        httpBaseUrl: ENDPOINT.httpBaseUrl,
        wsBaseUrl: ENDPOINT.wsBaseUrl,
      });
      const layerBroker = yield* makeDependencies({
        credentials: [["saved-1", new BearerConnectionCredential({ token: "old-bearer" })]],
        onCredentialPut: (_connectionId, credential) => stored.push(credential.token),
        // The server commits the renewal, but its first answer never arrives.
        renewSession: (request) => {
          renewCalls.push(request.headers.get("authorization"));
          return renewCalls.length === 1
            ? Response.json({ code: "unavailable" }, { status: 503 })
            : Response.json({
                renewed: true,
                expiresAt: "2026-12-20T00:00:00.000Z",
                access_token: "redelivered-bearer",
              });
        },
        authorizeBearer: (input) =>
          Effect.sync(() => authorized.push(input.bearerToken)).pipe(
            Effect.as({
              environmentId: input.expectedEnvironmentId,
              label: "Phone",
              httpBaseUrl: input.httpBaseUrl,
              socketUrl: "wss://environment.example.test/ws?wsTicket=ticket",
              httpAuthorization: { _tag: "Bearer" as const, token: input.bearerToken },
            }),
          ),
      });
      const resolver = yield* ConnectionResolver.ConnectionResolver.pipe(
        Effect.provide(layerBroker),
      );
      const entry = catalogEntry(target, Option.some(profile));

      const connecting = yield* resolver.prepare(entry).pipe(Effect.forkChild);
      // Well inside the grace window.
      yield* TestClock.adjust("1 minute");
      const prepared = yield* Fiber.join(connecting);

      expect(renewCalls).toEqual(["Bearer old-bearer", "Bearer old-bearer"]);
      expect(authorized).toEqual(["redelivered-bearer"]);
      expect(prepared.httpAuthorization).toEqual({ _tag: "Bearer", token: "redelivered-bearer" });
      expect(stored).toEqual(["redelivered-bearer"]);
    }),
  );

  it.effect("asks again on the next connect when every retry of a renewal failed", () =>
    Effect.gen(function* () {
      let available = false;
      const renewCalls: Array<string | null> = [];
      const target = new BearerConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Phone",
        connectionId: "saved-1",
      });
      const profile = new BearerConnectionProfile({
        connectionId: "saved-1",
        environmentId: ENVIRONMENT_ID,
        label: "Phone",
        httpBaseUrl: ENDPOINT.httpBaseUrl,
        wsBaseUrl: ENDPOINT.wsBaseUrl,
      });
      const layerBroker = yield* makeDependencies({
        credentials: [["saved-1", new BearerConnectionCredential({ token: "old-bearer" })]],
        renewSession: (request) => {
          renewCalls.push(request.headers.get("authorization"));
          return available
            ? Response.json({
                renewed: true,
                expiresAt: "2026-12-20T00:00:00.000Z",
                access_token: "redelivered-bearer",
              })
            : Response.json({ code: "unavailable" }, { status: 503 });
        },
      });
      const resolver = yield* ConnectionResolver.ConnectionResolver.pipe(
        Effect.provide(layerBroker),
      );
      const entry = catalogEntry(target, Option.some(profile));

      const first = yield* resolver.prepare(entry).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      expect((yield* Fiber.join(first)).httpAuthorization).toEqual({
        _tag: "Bearer",
        token: "old-bearer",
      });
      const failedCalls = renewCalls.length;
      expect(failedCalls).toBeGreaterThan(1);

      // A reconnect a few minutes later is not held back by the hourly limit.
      available = true;
      yield* TestClock.adjust("3 minutes");
      const second = yield* resolver.prepare(entry);
      expect(renewCalls).toHaveLength(failedCalls + 1);
      expect(second.httpAuthorization).toEqual({ _tag: "Bearer", token: "redelivered-bearer" });
    }),
  );

  // A renewed token the store refused must keep being used,
  // since the stored token it replaced dies when the grace window ends.
  it.effect("keeps using a renewed token the credential store refused, and stores it later", () =>
    Effect.gen(function* () {
      let putFails = true;
      const renewCalls: Array<string | null> = [];
      const authorized: Array<string> = [];
      const stored: Array<string> = [];
      const target = new BearerConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Phone",
        connectionId: "saved-1",
      });
      const profile = new BearerConnectionProfile({
        connectionId: "saved-1",
        environmentId: ENVIRONMENT_ID,
        label: "Phone",
        httpBaseUrl: ENDPOINT.httpBaseUrl,
        wsBaseUrl: ENDPOINT.wsBaseUrl,
      });
      const layerBroker = yield* makeDependencies({
        credentials: [["saved-1", new BearerConnectionCredential({ token: "old-bearer" })]],
        failCredentialPut: () => putFails,
        onCredentialPut: (_connectionId, credential) => stored.push(credential.token),
        renewSession: (request) => {
          renewCalls.push(request.headers.get("authorization"));
          return Response.json({
            renewed: true,
            expiresAt: "2026-12-20T00:00:00.000Z",
            access_token: "renewed-bearer",
          });
        },
        authorizeBearer: (input) =>
          Effect.sync(() => authorized.push(input.bearerToken)).pipe(
            Effect.as({
              environmentId: input.expectedEnvironmentId,
              label: "Phone",
              httpBaseUrl: input.httpBaseUrl,
              socketUrl: "wss://environment.example.test/ws?wsTicket=ticket",
              httpAuthorization: { _tag: "Bearer" as const, token: input.bearerToken },
            }),
          ),
      });
      const resolver = yield* ConnectionResolver.ConnectionResolver.pipe(
        Effect.provide(layerBroker),
      );
      const entry = catalogEntry(target, Option.some(profile));

      const first = yield* resolver.prepare(entry);
      expect(first.httpAuthorization).toEqual({ _tag: "Bearer", token: "renewed-bearer" });

      // Past the grace window, a reconnect still uses the renewed token, and
      // the daily check of the live connection does not fall back either.
      yield* TestClock.adjust("15 minutes");
      const reconnected = yield* resolver.prepare(entry);
      expect(reconnected.httpAuthorization).toEqual({ _tag: "Bearer", token: "renewed-bearer" });
      expect(yield* resolver.renewCredential(reconnected)).toEqual(Option.none());
      expect(authorized).toEqual(["renewed-bearer", "renewed-bearer"]);
      expect(renewCalls).toEqual(["Bearer old-bearer"]);

      // Once the store works again the renewed token is saved.
      putFails = false;
      expect(stored).toEqual([]);
      yield* resolver.prepare(entry);
      expect(stored).toEqual(["renewed-bearer"]);
    }),
  );

  it.effect("offers the saved SSH token on each connect and saves the one it gets back", () =>
    Effect.gen(function* () {
      const offeredTokens = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
      const target = new SshConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "SSH",
        connectionId: "ssh-1",
      });
      const profile = new SshConnectionProfile({
        connectionId: "ssh-1",
        environmentId: ENVIRONMENT_ID,
        label: "SSH",
        target: SSH_TARGET,
      });
      const layerBroker = yield* makeDependencies({
        credentials: [["ssh-1", new BearerConnectionCredential({ token: "revoked-token" })]],
        // The host accepts only the token it paired last; anything else pairs again.
        prepareSsh: (input) =>
          Ref.update(offeredTokens, (tokens) => [...tokens, input.bearerToken]).pipe(
            Effect.as({
              bootstrap: {
                target: input.target,
                httpBaseUrl: "http://127.0.0.1:4010",
                wsBaseUrl: "ws://127.0.0.1:4010",
                pairingToken: null,
              },
              bearerToken: "paired-token",
            }),
          ),
      });
      const broker = yield* ConnectionResolver.ConnectionResolver.pipe(Effect.provide(layerBroker));
      const entry = catalogEntry(target, Option.some(profile));

      const first = yield* broker.prepare(entry);
      const second = yield* broker.prepare(entry);

      expect(yield* Ref.get(offeredTokens)).toEqual(["revoked-token", "paired-token"]);
      expect(first.httpAuthorization).toMatchObject({ token: "paired-token" });
      expect(second.httpAuthorization).toMatchObject({ token: "paired-token" });
    }),
  );

  it.effect.each(["unchanged", "changed", "revocation-failed"] as const)(
    "handles %s SSH routing consent before saving or authorizing",
    (scenario) =>
      Effect.gen(function* () {
        const calls: string[] = [];
        const target = new SshConnectionTarget({
          environmentId: ENVIRONMENT_ID,
          label: "SSH",
          connectionId: "ssh-1",
        });
        const profile = new SshConnectionProfile({
          connectionId: target.connectionId,
          environmentId: ENVIRONMENT_ID,
          label: "SSH",
          target: SSH_TARGET,
        });
        const entry = catalogEntry(target, Option.some(profile));
        const preparedTarget =
          scenario === "unchanged"
            ? SSH_TARGET
            : { ...SSH_TARGET, hostname: "replacement.example.test" };
        const failure = new ConnectionTransientError({
          reason: "remote-unavailable",
          detail: "Could not persist routing consent.",
        });
        const permissions = yield* makeGitHubRoutingPermissions({
          read: Effect.succeed([
            {
              environmentId: ENVIRONMENT_ID,
              connectionKey: gitHubRoutingConnectionKey(entry)!,
              permission: "read-write",
            },
          ]),
          write: () =>
            Effect.sync(() => {
              calls.push("revoke");
            }).pipe(
              Effect.andThen(scenario === "revocation-failed" ? Effect.fail(failure) : Effect.void),
            ),
        });
        let savedProfile: ConnectionProfile = profile;
        const layerBroker = yield* makeDependencies({
          profileStore: {
            get: () => Effect.sync(() => Option.some(savedProfile)),
            put: (value) =>
              Effect.sync(() => {
                calls.push("profile");
                savedProfile = value;
              }),
            remove: () => Effect.die("unused"),
          },
          prepareSsh: () =>
            Effect.succeed({
              bootstrap: {
                target: preparedTarget,
                httpBaseUrl: "http://127.0.0.1:4010",
                wsBaseUrl: "ws://127.0.0.1:4010",
                pairingToken: null,
              },
              bearerToken: "ssh-bearer",
            }),
          authorizeBearer: (input) =>
            Effect.sync(() => {
              calls.push("authorize");
              return {
                environmentId: input.expectedEnvironmentId,
                label: "SSH",
                httpBaseUrl: input.httpBaseUrl,
                socketUrl: "ws://127.0.0.1:4010/ws?wsTicket=ssh",
                httpAuthorization: { _tag: "Bearer" as const, token: input.bearerToken },
              };
            }),
        });
        const broker = yield* ConnectionResolver.ConnectionResolver.pipe(
          Effect.provide(layerBroker),
        );
        const prepare = broker
          .prepare(entry)
          .pipe(Effect.provideService(GitHubRoutingPermissions, permissions));
        if (scenario === "revocation-failed") {
          expect(yield* Effect.flip(prepare)).toBe(failure);
          expect(savedProfile).toBe(profile);
          expect(calls).toEqual(["revoke"]);
        } else {
          expect((yield* prepare).socketUrl).toContain("wsTicket=ssh");
          expect(savedProfile).toMatchObject({ target: preparedTarget });
          expect(calls).toEqual(
            scenario === "unchanged"
              ? ["profile", "authorize"]
              : ["revoke", "profile", "authorize"],
          );
        }
        expect(yield* permissions.get(entry)).toBe(scenario === "changed" ? "off" : "read-write");
      }),
  );
});
