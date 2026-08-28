import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";

import { iot, iotidentity, mqtt5 } from "aws-iot-device-sdk-v2";

// Values shared by both the temporary claim connection and normal operation.
const endpoint = required("AWS_IOT_ENDPOINT");
const thingName = required("THING_NAME");
const templateName = required("FLEET_TEMPLATE_NAME");
const templateParameters = parseParameters(
  required("FLEET_TEMPLATE_PARAMETERS_JSON"),
);
const identityDir = process.env.IDENTITY_DIR || "/identity";
const claimCert = process.env.CLAIM_CERT_PATH || "/bootstrap/claim.pem.crt";
const claimKey =
  process.env.CLAIM_KEY_PATH || "/bootstrap/claim.private.pem.key";
const rootCa = process.env.ROOT_CA_PATH;

// Production credentials are generated on first boot and persist in this mount.
const deviceCert = join(identityDir, "device.pem.crt");
const deviceKey = join(identityDir, "private.pem.key");
const telemetryTopic = `factory/line-a/${thingName}/telemetry`;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function parseParameters(raw: string): Record<string, string> {
  // RegisterThing accepts only string-valued template parameters.
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("FLEET_TEMPLATE_PARAMETERS_JSON must be an object");
  }
  for (const parameter of Object.values(value)) {
    if (typeof parameter !== "string") {
      throw new Error("Every provisioning parameter must be a string");
    }
  }
  return value as Record<string, string>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function connect(
  certificatePath: string,
  privateKeyPath: string,
  clientId: string,
): Promise<mqtt5.Mqtt5Client> {
  // AWS IoT uses mutual TLS: AWS proves its identity with the root CA chain,
  // while this client proves its identity with its certificate/private key.
  const builder =
    iot.AwsIotMqtt5ClientConfigBuilder.newDirectMqttBuilderWithMtlsFromPath(
      endpoint,
      certificatePath,
      privateKeyPath,
    );
  if (rootCa) {
    builder.withCertificateAuthorityFromPath(undefined, rootCa);
  }
  builder.withConnectProperties({
    clientId,
    keepAliveIntervalSeconds: 60,
  });

  const client = new mqtt5.Mqtt5Client(builder.build());

  // Attach listeners before start() so an immediate result cannot be missed.
  const connected = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("MQTT connection timed out")),
      30_000,
    );
    client.once("connectionSuccess", () => {
      clearTimeout(timeout);
      resolve();
    });
    client.once("connectionFailure", (event) => {
      clearTimeout(timeout);
      reject(new Error(`MQTT connection failed: ${String(event.error)}`));
    });
  });
  client.start();
  await connected;
  return client;
}

async function disconnect(client: mqtt5.Mqtt5Client): Promise<void> {
  // Wait for the native MQTT client to stop before releasing its resources.
  const stopped = new Promise<void>((resolve) =>
    client.once("stopped", () => resolve()),
  );
  client.stop();
  await stopped;
  client.close();
}

async function atomicWrite(path: string, content: string): Promise<void> {
  // Write and fsync a temporary file, then rename it so readers never observe
  // a partially written certificate or private key.
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function saveDeviceCredentials(
  certificatePem: string,
  privateKey: string,
): Promise<void> {
  await mkdir(identityDir, { recursive: true, mode: 0o700 });
  await atomicWrite(deviceCert, `${certificatePem.trim()}\n`);
  await atomicWrite(deviceKey, `${privateKey.trim()}\n`);
}

async function provision(): Promise<void> {
  console.log(`Provisioning ${thingName} with the claim certificate...`);

  // The shared claim identity is used only for the provisioning exchange.
  const client = await connect(
    claimCert,
    claimKey,
    `lab-iot-provision-${thingName}`,
  );
  const identity = iotidentity.IotIdentityClientv2.newFromMqtt5(client, {
    maxRequestResponseSubscriptions: 2,
    maxStreamingSubscriptions: 0,
    operationTimeoutInSeconds: 60,
  });

  try {
    // Step 1: ask AWS to mint this device's unique certificate and private key.
    // Never log the response because it contains private credential material.
    const created = await identity.createKeysAndCertificate({});
    if (
      !created.certificatePem ||
      !created.privateKey ||
      !created.certificateOwnershipToken
    ) {
      throw new Error("AWS returned an incomplete certificate response");
    }

    // Step 2: exchange the short-lived ownership token through the provisioning
    // template. AWS creates the Thing and attaches the runtime policy.
    const registered = await identity.registerThing({
      templateName,
      certificateOwnershipToken: created.certificateOwnershipToken,
      parameters: templateParameters,
    });
    if (registered.thingName !== thingName) {
      throw new Error(
        `Template created ${registered.thingName ?? "no Thing"}; expected ${thingName}`,
      );
    }

    // Step 3: persist the generated production identity outside the container.
    await saveDeviceCredentials(created.certificatePem, created.privateKey);
    console.log(`Provisioned ${thingName}; production credentials saved.`);
  } finally {
    identity.close();
    await disconnect(client);
  }
}

async function publish(): Promise<void> {
  console.log(`Connecting as ${thingName} with production credentials...`);

  // From this point onward the device uses its unique identity, not the claim.
  const client = await connect(deviceCert, deviceKey, thingName);
  try {
    // QoS 1 asks AWS IoT Core to acknowledge receipt of this message.
    await client.publish({
      topicName: telemetryTopic,
      qos: mqtt5.QoS.AtLeastOnce,
      payload: JSON.stringify({
        thingName,
        observedAt: new Date().toISOString(),
        message: "hello from local container",
      }),
    });
    console.log(`Published one message to ${telemetryTopic}.`);
  } finally {
    await disconnect(client);
  }
}

async function main(): Promise<void> {
  // The persistent bind mount is the restart signal: two production credential
  // files mean provisioning previously completed normally.
  const [hasCert, hasKey] = await Promise.all([
    exists(deviceCert),
    exists(deviceKey),
  ]);
  if (hasCert !== hasKey) {
    // Never provision over incomplete local state; that could create a duplicate.
    throw new Error(
      "Only one production credential file exists; stop and investigate",
    );
  }
  if (!hasCert) {
    await provision();
  } else {
    console.log("Existing production credentials found; skipping provisioning.");
  }

  // Both a freshly provisioned device and a restarted device converge here.
  await publish();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Device failed: ${message}`);
  process.exitCode = 1;
});
