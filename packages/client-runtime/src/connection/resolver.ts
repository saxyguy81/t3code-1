import type {
  AuthClientPresentationMetadata,
  ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";

import {
  appendClientConnectionParams,
  type ClientOwnerParams,
  readClientOwnerParams,
  renewRemoteBearerSession,
} from "../authorization/remote.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  SshConnectionProfile,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import {
  credentialMissingError,
  environmentMismatchError,
  mapRemoteEnvironmentError,
  profileMissingError,
} from "./errors.ts";
import {
  GitHubRoutingPermissions,
  gitHubRoutingConnectionKey,
} from "./githubRoutingPermissions.ts";
import type {
  BearerConnectionTarget,
  ConnectionTarget,
  PreparedConnection,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "./model.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { ConnectionBlockedError, type ConnectionAttemptError } from "./model.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import {
  appendOrchestrationProtocol,
  orchestrationProtocolCompatibilityError,
} from "./compatibility.ts";
import { credentialConnectionId } from "./routes.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";

export class ConnectionResolver extends Context.Service<
  ConnectionResolver,
  {
    readonly prepare: (
      entry: ConnectionCatalogEntry,
    ) => Effect.Effect<PreparedConnection, ConnectionAttemptError>;
    /**
     * Authorizes a socket without the orchestration protocol gate, for hosts
     * too old to connect normally. Only update RPCs may run over it.
     */
    readonly prepareForUpdate: (entry: ConnectionCatalogEntry) => Effect.Effect<
      {
        readonly prepared: PreparedConnection;
        readonly descriptor: ExecutionEnvironmentDescriptor;
      },
      ConnectionAttemptError
    >;
    /**
     * Renews a prepared bearer connection's session when the server says it is
     * near expiry, and returns the connection with the new token. Never fails:
     * the old token keeps working until its own expiry.
     */
    readonly renewCredential: (
      prepared: PreparedConnection,
    ) => Effect.Effect<Option.Option<PreparedConnection>>;
  }
>()("@t3tools/client-runtime/connection/resolver/ConnectionResolver") {}

const isBearerProfile = Schema.is(BearerConnectionProfile);
// The server renews a session only in its last week, so asking more than
// hourly (every reconnect and route check prepares) would only cost requests.
const BEARER_RENEWAL_ATTEMPT_INTERVAL_MS = 60 * 60_000;
const BEARER_RENEWAL_TIMEOUT_MS = 5_000;
const isSshProfile = Schema.is(SshConnectionProfile);
const isBearerCredential = Schema.is(BearerConnectionCredential);

function primarySocketUrl(
  target: PrimaryConnectionTarget,
  clientMetadata: AuthClientPresentationMetadata | undefined,
  owners: ClientOwnerParams,
): string {
  const url = new URL(target.wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/ws";
  }
  appendClientConnectionParams(url, clientMetadata, "direct", owners);
  return url.toString();
}

const makePrimaryBroker = Effect.fn("clientRuntime.connection.broker.makePrimary")(function* () {
  const auth = yield* ClientCapabilities.PrimaryEnvironmentAuth;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.primary")(function* (
    target: PrimaryConnectionTarget,
  ) {
    const bearerToken = yield* auth.bearerToken;
    if (Option.isNone(bearerToken)) {
      return {
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: target.httpBaseUrl,
        socketUrl: primarySocketUrl(target, presentation.metadata, yield* readClientOwnerParams),
        httpAuthorization: null,
        target,
      } satisfies PreparedConnection;
    }

    const authorized = yield* remote.authorizeBearer({
      expectedEnvironmentId: target.environmentId,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
      bearerToken: bearerToken.value,
      connectionMethod: "direct",
    });
    return {
      ...authorized,
      target,
    } satisfies PreparedConnection;
  });
});

type BearerCredentialRenewal = (input: {
  readonly credentialId: string;
  readonly httpBaseUrl: string;
  readonly token: string;
}) => Effect.Effect<string>;

/**
 * Returns the token a bearer connection should use, renewing its session first
 * when the server says it is near expiry. The renewed token is stored before
 * it is used; the replaced one keeps working for a short grace window, so
 * requests already holding it finish. One renewal runs at a time, and a caller
 * holding a token another caller already replaced gets the stored one.
 */
const makeBearerCredentialRenewal = Effect.fn("clientRuntime.connection.makeBearerRenewal")(
  function* () {
    const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
    const httpClient = yield* HttpClient.HttpClient;
    const lock = yield* Semaphore.make(1);
    const lastAttemptAt = new Map<string, number>();

    const renew: BearerCredentialRenewal = Effect.fn("clientRuntime.connection.renewBearer")(
      function* (input) {
        const stored = yield* credentials
          .get(input.credentialId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (
          Option.isSome(stored) &&
          isBearerCredential(stored.value) &&
          stored.value.token !== input.token
        ) {
          return stored.value.token;
        }
        const now = yield* Clock.currentTimeMillis;
        const last = lastAttemptAt.get(input.credentialId);
        if (last !== undefined && now - last < BEARER_RENEWAL_ATTEMPT_INTERVAL_MS) {
          return input.token;
        }
        lastAttemptAt.set(input.credentialId, now);
        const result = yield* renewRemoteBearerSession({
          httpBaseUrl: input.httpBaseUrl,
          bearerToken: input.token,
          timeoutMs: BEARER_RENEWAL_TIMEOUT_MS,
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.tapError((error) =>
            Effect.logDebug("Could not renew the bearer session; keeping the current token.").pipe(
              Effect.annotateLogs({ ...safeErrorLogAttributes(error) }),
            ),
          ),
          Effect.option,
        );
        if (Option.isNone(result) || !result.value.renewed || !result.value.access_token) {
          return input.token;
        }
        const renewedToken = result.value.access_token;
        yield* credentials
          .put(input.credentialId, new BearerConnectionCredential({ token: renewedToken }))
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not store the renewed bearer token.").pipe(
                Effect.annotateLogs({ ...safeErrorLogAttributes(error) }),
              ),
            ),
          );
        return renewedToken;
      },
      lock.withPermits(1),
    );
    return renew;
  },
);

const makeBearerBroker = Effect.fn("clientRuntime.connection.broker.makeBearer")(function* (
  renewBearerCredential: BearerCredentialRenewal,
) {
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.bearer")(function* (
    entry: ConnectionCatalogEntry & { readonly target: BearerConnectionTarget },
  ) {
    const target = entry.target;
    const profile = yield* Effect.fromOption(entry.profile, () =>
      profileMissingError(target.connectionId),
    );
    if (!isBearerProfile(profile)) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: `Connection profile ${target.connectionId} is not a bearer connection.`,
      });
    }
    if (profile.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: profile.environmentId,
      });
    }
    if (profile.authorization === "t3-connect") {
      const authorized = yield* remote.authorizeDpop({
        expectedEnvironmentId: target.environmentId,
        directEndpoint: { httpBaseUrl: profile.httpBaseUrl, wsBaseUrl: profile.wsBaseUrl },
      });
      return { ...authorized, target } satisfies PreparedConnection;
    }
    const credentialId = credentialConnectionId(target.connectionId);
    const credential = yield* credentials.get(credentialId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(credentialMissingError(target.connectionId)),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (!isBearerCredential(credential)) {
      return yield* credentialMissingError(target.connectionId);
    }
    const bearerToken = yield* renewBearerCredential({
      credentialId,
      httpBaseUrl: profile.httpBaseUrl,
      token: credential.token,
    });
    const authorized = yield* remote.authorizeBearer({
      expectedEnvironmentId: target.environmentId,
      httpBaseUrl: profile.httpBaseUrl,
      wsBaseUrl: profile.wsBaseUrl,
      bearerToken,
      connectionMethod: "direct",
    });
    return {
      environmentId: authorized.environmentId,
      label: authorized.label,
      httpBaseUrl: authorized.httpBaseUrl,
      socketUrl: authorized.socketUrl,
      httpAuthorization: authorized.httpAuthorization,
      target,
    } satisfies PreparedConnection;
  });
});

const makeRelayBroker = Effect.fn("clientRuntime.connection.broker.makeRelay")(function* () {
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fnUntraced(
    function* (target: RelayConnectionTarget) {
      const authorized = yield* remote.authorizeDpop({
        expectedEnvironmentId: target.environmentId,
      });
      return {
        environmentId: authorized.environmentId,
        label: authorized.label,
        httpBaseUrl: authorized.httpBaseUrl,
        socketUrl: authorized.socketUrl,
        httpAuthorization: authorized.httpAuthorization,
        target,
      } satisfies PreparedConnection;
    },
    Effect.withSpan("clientRuntime.connection.broker.relay"),
    withRelayClientTracing,
  );
});

const makeSshBroker = Effect.fn("clientRuntime.connection.broker.makeSsh")(function* () {
  const profiles = yield* ConnectionProfileStore.ConnectionProfileStore;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const ssh = yield* ClientCapabilities.SshEnvironmentGateway;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.ssh")(function* (
    entry: ConnectionCatalogEntry & { readonly target: SshConnectionTarget },
  ) {
    const target = entry.target;
    const profile = yield* Effect.fromOption(entry.profile, () =>
      profileMissingError(target.connectionId),
    );
    if (!isSshProfile(profile)) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: `Connection profile ${target.connectionId} is not an SSH connection.`,
      });
    }
    if (profile.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: profile.environmentId,
      });
    }
    // Each pairing adds a session on the host, so connects reuse the saved token.
    const saved = Option.getOrUndefined(yield* credentials.get(target.connectionId));
    const savedToken = saved !== undefined && isBearerCredential(saved) ? saved.token : undefined;
    const prepared = yield* ssh.prepare({
      connectionId: target.connectionId,
      expectedEnvironmentId: target.environmentId,
      target: profile.target,
      ...(savedToken === undefined ? {} : { bearerToken: savedToken }),
    });
    if (prepared.bearerToken !== savedToken) {
      yield* credentials.put(
        target.connectionId,
        new BearerConnectionCredential({ token: prepared.bearerToken }),
      );
    }
    const preparedProfile = new SshConnectionProfile({
      connectionId: profile.connectionId,
      environmentId: profile.environmentId,
      label: profile.label,
      target: prepared.bootstrap.target,
    });
    if (
      gitHubRoutingConnectionKey(entry) !==
      gitHubRoutingConnectionKey({ ...entry, profile: Option.some(preparedProfile) })
    ) {
      const permissions = yield* GitHubRoutingPermissions;
      yield* permissions.forget(target.environmentId);
    }
    yield* profiles.put(preparedProfile);
    const authorized = yield* remote.authorizeBearer({
      expectedEnvironmentId: target.environmentId,
      httpBaseUrl: prepared.bootstrap.httpBaseUrl,
      wsBaseUrl: prepared.bootstrap.wsBaseUrl,
      bearerToken: prepared.bearerToken,
      connectionMethod: "ssh",
    });
    return {
      environmentId: authorized.environmentId,
      label: authorized.label,
      httpBaseUrl: authorized.httpBaseUrl,
      socketUrl: authorized.socketUrl,
      httpAuthorization: authorized.httpAuthorization,
      target,
    } satisfies PreparedConnection;
  });
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const renewBearerCredential = yield* makeBearerCredentialRenewal();
  const primary = yield* makePrimaryBroker();
  const bearer = yield* makeBearerBroker(renewBearerCredential);
  const relay = yield* makeRelayBroker();
  const ssh = yield* makeSshBroker();
  const httpClient = yield* HttpClient.HttpClient;

  const authorize = Effect.fn("clientRuntime.connection.broker.authorize")(function* (
    entry: ConnectionCatalogEntry,
  ) {
    const target: ConnectionTarget = entry.target;
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": target.environmentId,
      "connection.target.kind": target._tag,
    });
    const prepared = yield* (() => {
      switch (target._tag) {
        case "PrimaryConnectionTarget":
          return primary(target);
        case "BearerConnectionTarget":
          return bearer({ ...entry, target });
        case "RelayConnectionTarget":
          return relay(target);
        case "SshConnectionTarget":
          return ssh({ ...entry, target });
      }
    })();
    const descriptor = yield* fetchRemoteEnvironmentDescriptor({
      httpBaseUrl: prepared.httpBaseUrl,
    }).pipe(
      Effect.mapError(mapRemoteEnvironmentError),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    if (descriptor.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: descriptor.environmentId,
      });
    }
    return { prepared, descriptor };
  });

  const prepare = Effect.fn("clientRuntime.connection.broker.prepare")(function* (
    entry: ConnectionCatalogEntry,
  ) {
    const { prepared, descriptor } = yield* authorize(entry);
    const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
    if (compatibilityError !== null) {
      return yield* compatibilityError;
    }
    return {
      ...prepared,
      socketUrl: appendOrchestrationProtocol(prepared.socketUrl),
    };
  });

  // Only saved bearer connections renew: desktop and SSH bearers are minted
  // again on every start, and T3 Connect tokens re-exchange on their own.
  const renewCredential = (prepared: PreparedConnection) => {
    const authorization = prepared.httpAuthorization;
    if (prepared.target._tag !== "BearerConnectionTarget" || authorization?._tag !== "Bearer") {
      return Effect.succeedNone;
    }
    return renewBearerCredential({
      credentialId: credentialConnectionId(prepared.target.connectionId),
      httpBaseUrl: prepared.httpBaseUrl,
      token: authorization.token,
    }).pipe(
      Effect.map((token) =>
        token === authorization.token
          ? Option.none<PreparedConnection>()
          : Option.some({ ...prepared, httpAuthorization: { _tag: "Bearer" as const, token } }),
      ),
    );
  };

  return ConnectionResolver.of({ prepare, prepareForUpdate: authorize, renewCredential });
});

export const layer = Layer.effect(ConnectionResolver, make);
